import { BrowserQRCodeReader } from '@zxing/browser';
import qrcode from 'qrcode-generator';

window.ZXingBrowser = { BrowserQRCodeReader };
window.qrcode = qrcode;
