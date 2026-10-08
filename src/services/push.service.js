import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import PushDevice from '../models/yper/PushDevice.js';

export function pushConfigured() {
  try {
    return new URL(process.env.YPER_PUBLIC_URL).protocol === 'https:'
      && Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  } catch { return false; }
}

export async function sendPush(device, { body, path, tag }) {
  const origin = new URL(process.env.YPER_PUBLIC_URL);
  if (origin.protocol !== 'https:') throw new Error('YPER_PUBLIC_URL must use HTTPS');
  let app = getApps().find(item => item.name === 'yper-push');
  if (!app) {
    const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) : applicationDefault();
    app = initializeApp({ credential }, 'yper-push');
  }
  try {
    await getMessaging(app).send({
      token: device.token,
      notification: { title: 'Yper', body },
      data: { tag, path },
      webpush: {
        headers: { TTL: '1800', Urgency: 'normal' },
        notification: { icon: new URL('/apple-touch-icon.png', origin).href, tag },
        fcmOptions: { link: new URL(path, origin).href },
      },
    });
  } catch (error) {
    if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code)) {
      await PushDevice.deleteOne({ _id: device._id, user: device.user, token: device.token });
    }
    // Do not log the provider response: it may contain registration tokens.
    throw new Error('Push delivery failed');
  }
}
