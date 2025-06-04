// src/ui/AvatarUI.js
export default class AvatarUI {
    constructor(onAvatarSelected) {
      this.onAvatarSelected = onAvatarSelected;
      this.createUI();
    }
  
    createUI() {
      const container = document.createElement('div');
      container.id = 'avatarUI';
      container.style.cssText = `
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0,0,0,0.9);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 1000;
      `;
  
      const button = document.createElement('button');
      button.innerText = 'Créer mon avatar';
      button.style.cssText = `
        font-size: 1.5rem;
        padding: 1rem 2rem;
        cursor: pointer;
      `;
  
      button.addEventListener('click', () => {
        this.launchReadyPlayerMe();
      });
  
      container.appendChild(button);
      document.body.appendChild(container);
      this.container = container;
    }
  
    launchReadyPlayerMe() {
      const iframe = document.createElement('iframe');
      iframe.src = 'https://camagame.readyplayer.me/avatar';
      iframe.allow = 'camera *; microphone *';
      iframe.style.cssText = `
        width: 900px;
        height: 650px;
        border: none;
        position: absolute;
        left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        z-index: 1001;
      `;
  
      document.body.appendChild(iframe);
  
      window.addEventListener('message', (event) => {
        if (event.origin.includes('readyplayer.me') && event.data?.includes('.glb')) {
          this.onAvatarSelected(event.data);
          document.body.removeChild(iframe);
          document.body.removeChild(this.container);
        }
      });
    }
  }