import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// App icons from public/logo.svg. Maskable and Apple icons are full-bleed brand blue, so launchers that crop
// them to a circle or squircle show the train on blue, never a white ring.
const BLUE = '#1d4ed8';
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background: BLUE } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background: BLUE } },
  },
  images: ['public/logo.svg'],
});
