import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/Slipiq-Mini-App/',
  plugins: [react()],
});
