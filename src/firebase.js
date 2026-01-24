// ============================================================
// Firebase設定
// ============================================================

import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getFunctions, httpsCallable } from 'firebase/functions';

const firebaseConfig = {
  apiKey: "AIzaSyDkPbPvJCW7x9tVTtyRC4NmSSkGCSFNyuk",
  authDomain: "clinical-data-registry0123.firebaseapp.com",
  projectId: "clinical-data-registry0123",
  storageBucket: "clinical-data-registry0123.firebasestorage.app",
  messagingSenderId: "742760887798",
  appId: "1:742760887798:web:8dc17552630db3cd3703d7",
  measurementId: "G-BKXC909L1G"
};

// Firebase初期化
const app = initializeApp(firebaseConfig);

// 各サービスのエクスポート
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, 'asia-northeast1');
export { httpsCallable };
export default app;
