import EventBus from '../core/EventBus.js';

export default class HtmlHandler {
  constructor(container = document.body) {
    this.container = container;
    this.apiKey = null;
    this.element = null;

    EventBus.on('attributs:ready', (data) => {
      if (data.apiKey) {
        this.apiKey = data.apiKey;
      }
    });

    this.loadCss('/address-form.css');
    this.loadHtml('/address-form.html');
  }

  loadCss(href) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  async loadHtml(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Erreur chargement HTML: ${response.status}`);

      const html = await response.text();

      this.element = document.createElement('div');
      this.element.innerHTML = html;
      this.container.appendChild(this.element);

      this.bindEvents();

    } catch (err) {
      console.error('Erreur lors du chargement du formulaire HTML:', err);
    }
  }

  bindEvents() {
    if (!this.element) return;

    const submitBtn = this.element.querySelector('#submit-button');
    const addressInput = this.element.querySelector('#address-input');
    const errorMessage = this.element.querySelector('#error-message');

    const submitAddress = () => {
      const address = addressInput.value.trim();
      if (!address) return;

      this.validateAddress(address).then(isValid => {
        if (isValid) {
          window.savedAddress = address;
          console.log('Adresse sauvegardée dans window.savedAddress :', window.savedAddress); 
          EventBus.emit('addressSaved', address);
          EventBus.emit('player:reposition');
          this.closeForm();
        } else {
          if (errorMessage) errorMessage.style.display = 'block';
        }
      });
    };

    if (submitBtn) submitBtn.addEventListener('click', submitAddress);

    if (addressInput) {
      addressInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitAddress();
        }
      });
    }
  }

  async validateAddress(address) {
    if (!this.apiKey) {
      console.error('Clé API Mapbox non définie.');
      return false;
    }

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${this.apiKey}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.error('Erreur lors de la validation adresse:', response.statusText);
        return false;
      }
      const data = await response.json();
      return data.features && data.features.length > 0;
    } catch (e) {
      console.error('Erreur réseau:', e);
      return false;
    }
  }

  closeForm() {
    if (this.element && this.container.contains(this.element)) {
      this.container.removeChild(this.element);
    }
  }
}