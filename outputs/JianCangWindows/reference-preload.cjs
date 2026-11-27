'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jiancangReference', {
  ready: () => ipcRenderer.invoke('reference:ready'),
  menu: (imageVisible, canRetry) => ipcRenderer.invoke('reference:context-menu', imageVisible, canRetry),
  setImageSize: (width, height) => ipcRenderer.invoke('reference:image-size', width, height),
  resize: (mode, multiplier, anchorX, anchorY, animate, pointer) => ipcRenderer.invoke('reference:resize', mode, multiplier, anchorX, anchorY, animate, pointer),
  onZoomFrame: callback => { ipcRenderer.on('reference:zoom-frame', () => callback()); },
  advanceZoom: () => ipcRenderer.invoke('reference:advance-zoom'),
  beginMove: gesture => ipcRenderer.invoke('reference:begin-move', gesture),
  move: (gesture, dx, dy) => ipcRenderer.invoke('reference:move', gesture, dx, dy),
  endMove: gesture => ipcRenderer.invoke('reference:end-move', gesture),
  setPinned: value => ipcRenderer.invoke('reference:pin', value),
  setOpacity: value => ipcRenderer.invoke('reference:opacity', value),
  copyImage: thumbnail => ipcRenderer.invoke('reference:copy-image', thumbnail),
});
