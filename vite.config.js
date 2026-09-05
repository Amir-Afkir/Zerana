import { defineConfig } from 'vite';
<<<<<<< HEAD

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/Zerana/' : '/',
=======
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    open: true
  }
>>>>>>> 541ee88 ( batiment + arbre ajouté)
});
