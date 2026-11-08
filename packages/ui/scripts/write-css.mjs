// Writes dist/tokens.css from the built tokens (task 2-10): one source, no hand-kept CSS.
import { writeFileSync } from 'node:fs';
import { tokenCss } from '../dist/tokens.js';

writeFileSync(new URL('../dist/tokens.css', import.meta.url), tokenCss());
