// src/ui/AvatarSelector.js
export default class AvatarSelector {
    constructor(realPlayer, scene) {
      this.realPlayer = realPlayer;
      this.scene = scene;
  
      this.createUI();
      this.setupEvents();
    }
  
    createUI() {
      this.container = document.createElement('div');
      this.container.id = 'avatarContainer';
      this.container.style.cssText = `
        position: absolute;
        z-index: 1000;
        background: #222;
        padding: 8px;
        box-shadow: 0 0 16px rgba(0,0,0,0.3);
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        display: none;
      `;
  
      this.iframe = document.createElement('iframe');
      this.iframe.id = 'avatarIframe';
      this.iframe.className = 'avatarContent';
      this.iframe.allow = 'camera *; microphone *';
      this.iframe.style.cssText = `
        width: 900px;
        height: 650px;
        border: none;
      `;
  
      this.container.appendChild(this.iframe);
      document.body.appendChild(this.container);
    }
  
    setupEvents() {
      window.addEventListener('message', (event) => {
        if (event.origin.includes('readyplayer.me') && event.data?.includes('.glb')) {
          this.onAvatarSelected(event.data);
        }
      });
    }
  
    open() {
      this.iframe.src = 'https://camagame.readyplayer.me/avatar';
      this.container.style.display = 'block';
    }
  
    close() {
      this.container.style.display = 'none';
      this.iframe.src = '';
    }
  
    onAvatarSelected(modelUrl) {
      this.close();
      this.realPlayer.replaceModel(modelUrl, this.scene);
    }
  }