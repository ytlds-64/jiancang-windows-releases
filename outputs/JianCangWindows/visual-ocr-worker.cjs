'use strict';

const path = require('node:path');
const { parentPort } = require('node:worker_threads');
const { createWorker, OEM, PSM } = require('./vendor/ocr/node_modules/tesseract.js');

const data = path.join(__dirname, 'vendor', 'ocr');
let engine;

async function recognizer() {
  if (!engine) engine = (async () => {
    const worker = await createWorker(['eng', 'chi_sim'], OEM.LSTM_ONLY, {
      langPath: path.join(data, 'languages'),
      cacheMethod: 'none',
      errorHandler() {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '0' });
    return worker;
  })();
  return engine;
}

parentPort.on('message', async ({ id, bytes }) => {
  try {
    const worker = await recognizer();
    const { data: { text } } = await worker.recognize(Buffer.from(bytes));
    parentPort.postMessage({ id, text: typeof text === 'string' ? text.slice(0, 32_768) : '' });
  } catch {
    parentPort.postMessage({ id, error: true });
  }
});
