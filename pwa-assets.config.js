import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// App icons from public/logo.svg (the website logo on white). Maskable and Apple icons are full-bleed white, so launchers that crop
// them to a circle or squircle show the train on white, with no coloured ring.
const WHITE = '#ffffff';
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background: WHITE } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background: WHITE } },
  },
  images: ['public/logo.svg'],
});
