import { mount } from 'svelte'
import '@fontsource/press-start-2p'   // пиксельный шрифт для темы Terraria
import '@fontsource/russo-one'        // техно-шрифт для темы Doom Eternal (латиница+кириллица)
import './app.css'
import App from './App.svelte'

const app = mount(App, { target: document.getElementById('app') })

export default app
