import { mount } from 'svelte'
import '@fontsource/press-start-2p'   // pixel font for the Terraria theme
import '@fontsource/russo-one'        // techno font for the Doom Eternal theme (Latin+Cyrillic)
import './app.css'
import App from './App.svelte'

const app = mount(App, { target: document.getElementById('app') })

export default app
