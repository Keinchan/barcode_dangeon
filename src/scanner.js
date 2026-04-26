import { BrowserMultiFormatReader } from '@zxing/browser';

let reader = null;

export async function startScanner(onResult) {
  reader = new BrowserMultiFormatReader();

  const devices = await BrowserMultiFormatReader.listVideoInputDevices();
  // 背面カメラを優先
  const device =
    devices.find(d => /back|rear|environment/i.test(d.label)) ||
    devices[devices.length - 1];

  await reader.decodeFromVideoDevice(
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
  if (reader) { reader.reset(); reader = null; }
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
