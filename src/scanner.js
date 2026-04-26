import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

let reader   = null;
let controls = null;

// 商品バーコードに絞ってヒント指定（精度・速度向上）
function buildHints() {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13,   // JAN-13 / EAN-13（日本の商品バーコードのほとんど）
    BarcodeFormat.EAN_8,    // JAN-8 / EAN-8
    BarcodeFormat.UPC_A,    // 米国UPC-A
    BarcodeFormat.UPC_E,    // 米国UPC-E
    BarcodeFormat.CODE_128, // 物流系の数字バーコード
    BarcodeFormat.ITF,      // ITF（書籍流通など）
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return hints;
}

export async function startScanner(onResult) {
  reader = new BrowserMultiFormatReader(buildHints());

  const devices = await BrowserMultiFormatReader.listVideoInputDevices();
  // 背面カメラを優先
  const device =
    devices.find(d => /back|rear|environment/i.test(d.label)) ||
    devices[devices.length - 1];

  controls = await reader.decodeFromVideoDevice(
    device?.deviceId ?? null,
    'scanner-video',
    (result, err) => {
      if (!result) return;
      const text = result.getText();
      // JAN/EAN/UPC 系（数字のみ 8〜20桁）のみ受け付ける
      if (/^\d{8,20}$/.test(text)) {
        onResult(text);
      }
    },
  );
}

export function stopScanner() {
  if (controls) {
    try { controls.stop(); } catch { /* noop */ }
    controls = null;
  }
  reader = null;
}

export function getPosition() {
  return new Promise(resolve => {
    if (!navigator.geolocation) {
      resolve({ lat: 35.6762, lng: 139.6503 }); // 東京デフォルト
      return;
    }
    navigator.geolocation.getCurrentPosition(
      p  => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ lat: 35.6762, lng: 139.6503 }),
      { timeout: 6000, enableHighAccuracy: true },
    );
  });
}
