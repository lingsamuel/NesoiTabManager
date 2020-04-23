import Vue from 'vue'
import App from './App.vue'
import 'element-ui/lib/theme-chalk/index.css';
import ElementUI from 'element-ui';

Vue.use(ElementUI);

import ChromeWindow from './components/ChromeWindow.vue'
Vue.component("chrome-window", ChromeWindow);

new Vue({
    el: '#app',
    render: h => h(App)
});
