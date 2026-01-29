// ============================================================
// 臨床データ管理アプリ - Firebase版
// ============================================================

import React, { useState, useEffect, createContext, useContext, useRef } from 'react';
import { auth, db, functions, httpsCallable } from './firebase';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail
} from 'firebase/auth';
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  getDocs,
  getDoc,
  setDoc,
  where
} from 'firebase/firestore';
// Tesseract.jsは不要になりました（Cloud Vision APIに移行）
import * as XLSX from 'xlsx';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
import { Line } from 'react-chartjs-2';

// Chart.js登録
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

// ============================================================
// 認証コンテキスト
// ============================================================
const AuthContext = createContext();

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        try {
          // 管理者かどうかチェック
          const adminDoc = await getDoc(doc(db, 'config', 'admin'));
          if (adminDoc.exists() && adminDoc.data().email === currentUser.email) {
            setIsAdmin(true);
          } else {
            setIsAdmin(false);
          }
        } catch (err) {
          console.error('Error checking admin status:', err);
          setIsAdmin(false);
        }
      } else {
        setIsAdmin(false);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  // メールアドレスが許可リストに含まれているかチェック
  const checkEmailAllowed = async (email) => {
    try {
      // まず許可リスト機能が有効かチェック
      const configDoc = await getDoc(doc(db, 'config', 'settings'));
      if (!configDoc.exists() || !configDoc.data().emailAllowlistEnabled) {
        return true; // 機能が無効なら全て許可
      }

      // 許可リストをチェック
      const allowedQuery = query(
        collection(db, 'allowedEmails'),
        where('email', '==', email.toLowerCase())
      );
      const snapshot = await getDocs(allowedQuery);
      return !snapshot.empty;
    } catch (err) {
      console.error('Error checking email allowlist:', err);
      return true; // エラー時は許可（フェイルオープン）
    }
  };

  const signup = async (email, password) => {
    // 許可リストをチェック
    const isAllowed = await checkEmailAllowed(email);
    if (!isAllowed) {
      throw { code: 'auth/email-not-allowed', message: 'このメールアドレスは許可されていません' };
    }
    return createUserWithEmailAndPassword(auth, email, password);
  };

  const login = (email, password) => {
    return signInWithEmailAndPassword(auth, email, password);
  };

  const logout = () => {
    return signOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, signup, login, logout, loading, isAdmin, checkEmailAllowed }}>
      {!loading && children}
    </AuthContext.Provider>
  );
}

function useAuth() {
  return useContext(AuthContext);
}

// ============================================================
// OCR処理 - 個人情報フィルタリング付き
// ============================================================

// 検査項目の正規化マッピング（日本語→英語略称）
const labItemMapping = {
  // 蛋白
  'TP': ['TP', '総蛋白', '総タンパク'],
  'Alb': ['Alb', 'ALB', 'アルブミン', '7ルブミン', 'ｱﾙﾌﾞﾐﾝ'],
  'A/G': ['A/G', 'A/G比', 'AG比'],

  // 腎機能
  'BUN': ['BUN', 'UN', '尿素窒素', 'UN(尿素窒素)'],
  'Cr': ['Cr', 'CRE', 'クレアチニン', 'CRE(クレアチニン)', 'ｸﾚｱﾁﾆﾝ'],
  'eGFR': ['eGFR', 'EGFR', '推算GFR'],
  'Ccr': ['Ccr', 'CCR', '推算Ccr', 'クレアチニンクリアランス'],
  'UA': ['UA', '尿酸'],

  // 肝機能
  'AST': ['AST', 'GOT', 'AST(GOT)', 'AST（GOT）'],
  'ALT': ['ALT', 'GPT', 'ALT(GPT)', 'ALT（GPT）'],
  'γ-GTP': ['γ-GTP', 'GGT', 'γGTP', 'ガンマGTP', 'r-GTP'],
  'ALP': ['ALP', 'ALP_IE', 'ALP_IFCC', 'アルカリフォスファターゼ'],
  'LDH': ['LDH', 'LD', 'LDH_IE', 'LDH_IFCC', '乳酸脱水素酵素'],
  'T-Bil': ['T-Bil', 'TB', 'T-Bi1', '総ビリルビン', 'T-BIL(総ビリルビン)', '総ビ'],
  'D-Bil': ['D-Bil', 'DB', 'D-Bi1', '直接ビリルビン', 'D-BIL(直接ビリルビン)', '直ビ', '直接ビ'],
  'I-Bil': ['I-Bil', '間接ビリルビン', '間接ビ', '間ビ'],
  'ChE': ['ChE', 'CHE', 'コリンエステラーゼ'],

  // 電解質
  'Na': ['Na', 'ナトリウム', 'Na(ナトリウム)'],
  'K': ['K', 'カリウム', 'K(カリウム)'],
  'Cl': ['Cl', 'クロール', 'Cl(クロール)'],
  'Ca': ['Ca', 'カルシウム', 'Ca(カルシウム)'],
  'IP': ['IP', 'P', 'リン', '無機リン', 'IP(無機リン)'],
  'Mg': ['Mg', 'マグネシウム', 'Mg(マグネシウム)'],
  'Fe': ['Fe', '鉄', '血清鉄'],
  'TIBC': ['TIBC', '総鉄結合能'],
  'UIBC': ['UIBC', '不飽和鉄結合能'],
  'フェリチン': ['フェリチン', 'Ferritin'],
  '補正Ca': ['補正Ca', '補正カルシウム'],

  // 血算
  'WBC': ['WBC', '白血球', '白血球数'],
  'RBC': ['RBC', '赤血球', '赤血球数'],
  'Hb': ['Hb', 'HGB', 'ヘモグロビン', 'ﾍﾓｸﾞﾛﾋﾞﾝ'],
  'Hct': ['Hct', 'HCT', 'ヘマトクリット', 'ﾍﾏﾄｸﾘｯﾄ'],
  'PLT': ['PLT', '血小板', '血小板数'],
  'MCV': ['MCV'],
  'MCH': ['MCH'],
  'MCHC': ['MCHC'],
  'Ret': ['Ret', '網赤血球', 'Retic'],

  // 血液像
  'Baso': ['Baso', '好塩基球', 'Basophil'],
  'Eosino': ['Eosino', 'Eos', '好酸球', 'Eosinophil'],
  'Neut': ['Neut', 'Neu', '好中球', 'Neutrophil', 'Neut-T'],
  'Lymph': ['Lymph', 'Lym', 'リンパ球', 'Lymphocyte'],
  'Mono': ['Mono', 'Mon', '単球', 'Monocyte'],
  'Seg': ['Seg', '分葉核球'],
  'Stab': ['Stab', '桿状核球'],

  // 炎症マーカー
  'CRP': ['CRP', 'C反応性蛋白'],
  'ESR': ['ESR', '赤沈', '血沈'],
  'PCT': ['PCT', 'プロカルシトニン'],

  // 凝固
  'PT': ['PT', 'プロトロンビン時間'],
  'APTT': ['APTT', '活性化部分トロンボプラスチン時間'],
  'Fib': ['Fib', 'フィブリノゲン', 'Fbg'],
  'D-dimer': ['D-dimer', 'Dダイマー', 'DD'],
  'FDP': ['FDP'],
  'AT-III': ['AT-III', 'AT3', 'アンチトロンビン'],

  // 糖代謝
  'Glu': ['Glu', 'GLU', '血糖', 'BS', 'グルコース'],
  'HbA1c': ['HbA1c', 'A1c', 'ヘモグロビンA1c'],

  // 脂質
  'TC': ['TC', 'T-Cho', '総コレステロール', 'T-CHO'],
  'TG': ['TG', '中性脂肪', 'トリグリセリド'],
  'HDL': ['HDL', 'HDL-C', 'HDLコレステロール'],
  'LDL': ['LDL', 'LDL-C', 'LDLコレステロール'],

  // 心筋マーカー
  'CK': ['CK', 'CPK'],
  'CK-MB': ['CK-MB', 'CKMB'],
  'TnI': ['TnI', 'トロポニンI'],
  'TnT': ['TnT', 'トロポニンT'],
  'BNP': ['BNP'],
  'NT-proBNP': ['NT-proBNP', 'NTproBNP'],

  // 甲状腺
  'TSH': ['TSH'],
  'FT3': ['FT3', '遊離T3'],
  'FT4': ['FT4', '遊離T4'],

  // 腫瘍マーカー
  'CA19-9': ['CA19-9', 'CA199', 'CA19-9_IE', 'CA19-9_ECLIA'],
  'CA125': ['CA125', 'CA125_IE', 'CA125_ECLIA'],
  'CEA': ['CEA'],
  'AFP': ['AFP'],
  'PSA': ['PSA'],
  'SCC': ['SCC', 'SCC_IE', 'SCC_ECLIA'],

  // 髄液検査
  'CSF細胞数': ['CSF細胞', '髄液細胞', '細胞数'],
  'CSF蛋白': ['CSF蛋白', '髄液蛋白'],
  'CSF糖': ['CSF糖', '髄液糖'],

  // その他
  'Amy': ['Amy', 'AMY', 'アミラーゼ'],
  'Lip': ['Lip', 'リパーゼ'],
  'CysC': ['CysC', 'シスタチンC'],
  'NH3': ['NH3', 'アンモニア'],
  'Lac': ['Lac', '乳酸'],
  'D/T比': ['D/T比', 'D/T'],
};

const labItemUnits = {
  // 血算
  'WBC': '/μL', 'RBC': '×10⁴/μL', 'Hb': 'g/dL', 'Hct': '%', 'PLT': '×10⁴/μL',
  'MCV': 'fL', 'MCH': 'pg', 'MCHC': '%', 'Ret': '%',
  // 血液像
  'Baso': '%', 'Eosino': '%', 'Neut': '%', 'Lymph': '%', 'Mono': '%', 'Seg': '%', 'Stab': '%',
  // 炎症
  'CRP': 'mg/dL', 'ESR': 'mm/h', 'PCT': 'ng/mL',
  // 肝機能
  'AST': 'U/L', 'ALT': 'U/L', 'γ-GTP': 'U/L', 'ALP': 'U/L', 'LDH': 'U/L',
  'T-Bil': 'mg/dL', 'D-Bil': 'mg/dL', 'I-Bil': 'mg/dL', 'ChE': 'U/L',
  // 腎機能
  'BUN': 'mg/dL', 'Cr': 'mg/dL', 'eGFR': 'mL/min/1.73m²', 'Ccr': 'mL/min', 'UA': 'mg/dL',
  // 電解質
  'Na': 'mEq/L', 'K': 'mEq/L', 'Cl': 'mEq/L', 'Ca': 'mg/dL', 'IP': 'mg/dL', 'P': 'mg/dL',
  'Mg': 'mg/dL', 'Fe': 'μg/dL', '補正Ca': 'mg/dL',
  // 蛋白
  'TP': 'g/dL', 'Alb': 'g/dL', 'A/G': '',
  // 糖代謝
  'Glu': 'mg/dL', 'HbA1c': '%',
  // 脂質
  'TC': 'mg/dL', 'TG': 'mg/dL', 'HDL': 'mg/dL', 'LDL': 'mg/dL',
  // 凝固
  'PT': '秒', 'APTT': '秒', 'Fib': 'mg/dL', 'D-dimer': 'μg/mL', 'FDP': 'μg/mL',
  // 心筋
  'CK': 'U/L', 'CK-MB': 'U/L', 'TnI': 'ng/mL', 'TnT': 'ng/mL', 'BNP': 'pg/mL', 'NT-proBNP': 'pg/mL',
  // 甲状腺
  'TSH': 'μIU/mL', 'FT3': 'pg/mL', 'FT4': 'ng/dL',
  // 腫瘍マーカー
  'CA19-9': 'U/mL', 'CA125': 'U/mL', 'CEA': 'ng/mL', 'AFP': 'ng/mL', 'PSA': 'ng/mL', 'SCC': 'ng/mL',
  // 髄液
  'CSF細胞数': '/μL', 'CSF蛋白': 'mg/dL', 'CSF糖': 'mg/dL',
  // その他
  'Amy': 'U/L', 'Lip': 'U/L', 'NH3': 'μg/dL', 'Lac': 'mmol/L', 'D/T比': '',
};

// 項目名を正規化する関数
function normalizeLabItem(rawName) {
  const cleaned = rawName.trim()
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[ー−]/g, '-');

  for (const [normalizedName, aliases] of Object.entries(labItemMapping)) {
    for (const alias of aliases) {
      if (cleaned === alias ||
          cleaned.includes(alias) ||
          alias.includes(cleaned) ||
          cleaned.toLowerCase() === alias.toLowerCase()) {
        return normalizedName;
      }
    }
  }
  return null;
}

// 行ベースで検査データを解析
function parseLabLine(line) {
  // 前後の空白を削除し、複数の空白を単一に
  const cleaned = line.trim().replace(/\s+/g, ' ');

  // 行番号を除去（例: "1 TP(総蛋白)" → "TP(総蛋白)"）
  const withoutLineNum = cleaned.replace(/^\d+\s+/, '');

  // パターン1: "項目名 数値" または "項目名(日本語) 数値"
  // 例: "TP(総蛋白) 5.9" "eGFR 72.4" "白血球数 2860"
  const pattern1 = /^([A-Za-zγ\-\/]+(?:[（(][^）)]+[）)])?|[ぁ-んァ-ン一-龥]+(?:[（(][^）)]+[）)])?)\s+([\d.]+)/;

  // パターン2: 数値が複数ある場合（最初の数値を取得）
  // 例: "AST(GOT) 64 H 23"
  const pattern2 = /^(.+?)\s+([\d.]+)\s*[LHN]?\s/;

  // パターン3: タブ区切りや特殊フォーマット
  const pattern3 = /^([A-Za-zγ\-\/０-９0-9]+|[ぁ-んァ-ン一-龥]+)\s*[\t\s]+([\d.]+)/;

  let match = withoutLineNum.match(pattern1) || withoutLineNum.match(pattern2) || withoutLineNum.match(pattern3);

  if (match) {
    const rawItemName = match[1];
    const value = parseFloat(match[2]);

    if (!isNaN(value)) {
      const normalizedName = normalizeLabItem(rawItemName);
      if (normalizedName) {
        return {
          item: normalizedName,
          value: value,
          unit: labItemUnits[normalizedName] || ''
        };
      }
    }
  }

  return null;
}

// 個人情報除外パターン
const piiPatterns = [
  /患者(名|氏名|ID|番号)\s*[:：]?\s*[\u4e00-\u9faf\u3040-\u309f\u30a0-\u30ffA-Za-z]+/g,
  /〒?\d{3}-?\d{4}/g,
  /[\u4e00-\u9faf]+[都道府県][\u4e00-\u9faf]+[市区町村]/g,
  /\d{4}[年\/\-]\d{1,2}[月\/\-]\d{1,2}[日]?\s*(生|生年月日)/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\d{2,4}-\d{2,4}-\d{4}/g, // 電話番号
  /(様|殿|御中)/g,
];

async function performOCR(imageFile, onProgress) {
  try {
    // プログレス表示開始
    if (onProgress) onProgress(10);

    // 画像をBase64に変換
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // data:image/...;base64, の部分を除去
        const base64String = reader.result.split(',')[1];
        resolve(base64String);
      };
      reader.onerror = reject;
      reader.readAsDataURL(imageFile);
    });

    if (onProgress) onProgress(30);

    // Cloud Functionsを呼び出し
    const processLabImage = httpsCallable(functions, 'processLabImage');

    if (onProgress) onProgress(50);

    const result = await processLabImage({ imageBase64: base64 });

    if (onProgress) onProgress(100);

    console.log('Cloud Vision Result:', result.data);

    return {
      success: result.data.success,
      data: result.data.data || [],
      rawTextLength: result.data.rawTextLength || 0,
      itemsFound: result.data.itemsFound || 0
    };
  } catch (error) {
    console.error('OCR Error:', error);
    return {
      success: false,
      error: error.message,
      data: []
    };
  }
}

// ============================================================
// スタイル定義
// ============================================================
const styles = {
  // Auth styles
  authContainer: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #1e3a5f 0%, #2d4a6f 50%, #1a365d 100%)',
    padding: '20px',
    fontFamily: "'Noto Sans JP', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  authCard: {
    background: '#fff',
    borderRadius: '20px',
    padding: '48px 40px',
    width: '100%',
    maxWidth: '440px',
    boxShadow: '0 25px 80px rgba(0,0,0,0.35)',
  },
  authHeader: {
    textAlign: 'center',
    marginBottom: '36px',
  },
  logoIcon: {
    width: '56px',
    height: '56px',
    background: 'linear-gradient(135deg, #1a365d 0%, #2b4a7c 100%)',
    borderRadius: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 20px',
    boxShadow: '0 4px 20px rgba(26, 54, 93, 0.3)',
  },
  authTitle: {
    fontSize: '26px',
    fontWeight: '700',
    color: '#1a365d',
    margin: '0 0 8px 0',
    letterSpacing: '-0.5px',
  },
  authSubtitle: {
    fontSize: '14px',
    color: '#64748b',
    margin: 0,
  },
  authForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  authFooter: {
    marginTop: '28px',
    paddingTop: '24px',
    borderTop: '1px solid #e2e8f0',
  },
  footerText: {
    fontSize: '12px',
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 1.7,
  },

  // Form elements
  inputGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  inputLabel: {
    fontSize: '13px',
    fontWeight: '600',
    color: '#475569',
  },
  input: {
    padding: '14px 16px',
    border: '2px solid #e2e8f0',
    borderRadius: '10px',
    fontSize: '15px',
    transition: 'all 0.2s',
    outline: 'none',
    fontFamily: 'inherit',
  },
  errorText: {
    color: '#dc2626',
    fontSize: '13px',
    margin: 0,
    padding: '8px 12px',
    background: '#fef2f2',
    borderRadius: '8px',
  },

  // Buttons
  primaryButton: {
    padding: '16px 28px',
    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'all 0.2s',
    boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35)',
    fontFamily: 'inherit',
  },
  linkButton: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    fontSize: '14px',
    cursor: 'pointer',
    textDecoration: 'none',
    fontFamily: 'inherit',
  },
  cancelButton: {
    padding: '14px 24px',
    background: '#f1f5f9',
    color: '#475569',
    border: 'none',
    borderRadius: '10px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  logoutButton: {
    padding: '10px 18px',
    background: 'transparent',
    color: '#64748b',
    border: '1px solid #cbd5e1',
    borderRadius: '8px',
    fontSize: '13px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.2s',
  },
  backButton: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    fontSize: '15px',
    cursor: 'pointer',
    padding: '8px 0',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  editButton: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    fontSize: '13px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  saveButton: {
    marginTop: '10px',
    padding: '10px 20px',
    background: '#059669',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '13px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  addButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '16px 28px',
    background: 'linear-gradient(135deg, #059669 0%, #047857 100%)',
    color: '#fff',
    border: 'none',
    borderRadius: '12px',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    marginBottom: '28px',
    boxShadow: '0 4px 14px rgba(5, 150, 105, 0.3)',
    fontFamily: 'inherit',
  },
  addIcon: {
    fontSize: '22px',
    fontWeight: '300',
  },
  addLabButton: {
    padding: '12px 22px',
    background: '#f1f5f9',
    color: '#334155',
    border: 'none',
    borderRadius: '10px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontFamily: 'inherit',
    transition: 'all 0.2s',
  },
  deleteButton: {
    padding: '8px 14px',
    background: '#fef2f2',
    color: '#dc2626',
    border: 'none',
    borderRadius: '6px',
    fontSize: '12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  // Layout
  mainContainer: {
    minHeight: '100vh',
    background: '#f8fafc',
    fontFamily: "'Noto Sans JP', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '18px 36px',
    background: '#fff',
    borderBottom: '1px solid #e2e8f0',
    position: 'sticky',
    top: 0,
    zIndex: 100,
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '18px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '18px',
  },
  headerTitle: {
    fontSize: '22px',
    fontWeight: '700',
    color: '#1e293b',
    margin: 0,
  },
  headerBadge: {
    padding: '6px 14px',
    background: '#f1f5f9',
    borderRadius: '20px',
    fontSize: '13px',
    color: '#475569',
    fontWeight: '500',
  },
  diagnosisBadge: {
    padding: '8px 16px',
    background: '#eff6ff',
    color: '#1d4ed8',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: '600',
  },
  userInfo: {
    fontSize: '14px',
    color: '#64748b',
  },
  content: {
    padding: '36px',
    maxWidth: '1280px',
    margin: '0 auto',
  },
  detailContent: {
    padding: '36px',
    maxWidth: '960px',
    margin: '0 auto',
  },

  // Patient cards
  patientGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '24px',
  },
  patientCard: {
    background: '#fff',
    borderRadius: '16px',
    padding: '24px',
    cursor: 'pointer',
    transition: 'all 0.2s',
    border: '1px solid #e2e8f0',
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  },
  patientCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '14px',
  },
  patientId: {
    fontSize: '13px',
    fontWeight: '700',
    color: '#2563eb',
    fontFamily: "'JetBrains Mono', monospace",
    background: '#eff6ff',
    padding: '4px 10px',
    borderRadius: '6px',
  },
  labCount: {
    fontSize: '12px',
    color: '#64748b',
    background: '#f1f5f9',
    padding: '4px 12px',
    borderRadius: '12px',
  },
  patientDiagnosis: {
    fontSize: '18px',
    fontWeight: '600',
    color: '#1e293b',
    margin: '0 0 10px 0',
  },
  patientMeta: {
    fontSize: '13px',
    color: '#64748b',
  },
  patientMemo: {
    marginTop: '14px',
    padding: '12px 14px',
    background: '#f8fafc',
    borderRadius: '8px',
    fontSize: '13px',
    color: '#475569',
    lineHeight: 1.6,
    borderLeft: '3px solid #e2e8f0',
  },

  // Empty states
  emptyState: {
    textAlign: 'center',
    padding: '80px 20px',
    color: '#64748b',
  },
  emptyIcon: {
    fontSize: '56px',
    marginBottom: '20px',
    opacity: 0.6,
  },
  emptyHint: {
    fontSize: '14px',
    marginTop: '10px',
    color: '#94a3b8',
  },
  emptyLab: {
    textAlign: 'center',
    padding: '50px',
    background: '#f8fafc',
    borderRadius: '12px',
    color: '#64748b',
    border: '2px dashed #e2e8f0',
  },

  // Sections
  section: {
    background: '#fff',
    borderRadius: '16px',
    padding: '28px',
    marginBottom: '28px',
    border: '1px solid #e2e8f0',
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
  },
  sectionTitle: {
    fontSize: '17px',
    fontWeight: '700',
    color: '#1e293b',
    margin: 0,
  },
  infoGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '20px',
    marginBottom: '24px',
  },
  infoItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  infoLabel: {
    fontSize: '11px',
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.8px',
  },
  infoValue: {
    fontSize: '15px',
    color: '#1e293b',
    fontWeight: '500',
  },
  memoSection: {
    paddingTop: '20px',
    borderTop: '1px solid #e2e8f0',
  },
  memoHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '10px',
  },
  memoText: {
    fontSize: '14px',
    color: '#475569',
    lineHeight: 1.7,
    margin: 0,
  },

  // Lab timeline
  labTimeline: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  labCard: {
    background: '#f8fafc',
    borderRadius: '14px',
    padding: '20px',
    border: '1px solid #e2e8f0',
  },
  labCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  labDate: {
    fontSize: '16px',
    fontWeight: '700',
    color: '#1e293b',
  },
  labItemCount: {
    fontSize: '12px',
    color: '#64748b',
  },
  labDataGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
    gap: '12px',
  },
  labDataItem: {
    display: 'flex',
    flexDirection: 'column',
    padding: '12px',
    background: '#fff',
    borderRadius: '10px',
    border: '1px solid #e2e8f0',
  },
  labItemName: {
    fontSize: '11px',
    fontWeight: '700',
    color: '#64748b',
    marginBottom: '4px',
    letterSpacing: '0.3px',
  },
  labItemValue: {
    fontSize: '18px',
    fontWeight: '700',
    color: '#1e293b',
  },
  labItemUnit: {
    fontSize: '11px',
    fontWeight: '400',
    color: '#94a3b8',
  },

  // Modal
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(15, 23, 42, 0.6)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '20px',
  },
  modal: {
    background: '#fff',
    borderRadius: '20px',
    padding: '36px',
    width: '100%',
    maxWidth: '500px',
    maxHeight: '90vh',
    overflowY: 'auto',
    boxShadow: '0 25px 80px rgba(0,0,0,0.3)',
  },
  modalTitle: {
    fontSize: '22px',
    fontWeight: '700',
    color: '#1e293b',
    margin: '0 0 8px 0',
  },
  modalNote: {
    fontSize: '13px',
    color: '#64748b',
    marginBottom: '28px',
    padding: '12px 14px',
    background: '#fef3c7',
    borderRadius: '8px',
    border: '1px solid #fcd34d',
  },
  modalActions: {
    display: 'flex',
    gap: '14px',
    marginTop: '28px',
    justifyContent: 'flex-end',
  },

  // Upload
  uploadSection: {
    marginTop: '20px',
  },
  uploadArea: {
    marginTop: '10px',
  },
  uploadLabel: {
    display: 'block',
    cursor: 'pointer',
  },
  uploadContent: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '48px',
    border: '2px dashed #cbd5e1',
    borderRadius: '14px',
    background: '#f8fafc',
    transition: 'all 0.2s',
  },
  uploadIcon: {
    fontSize: '42px',
    marginBottom: '14px',
  },
  uploadHint: {
    fontSize: '12px',
    color: '#64748b',
    marginTop: '10px',
    textAlign: 'center',
  },
  previewContainer: {
    borderRadius: '12px',
    overflow: 'hidden',
    border: '1px solid #e2e8f0',
  },
  previewImage: {
    width: '100%',
    maxHeight: '220px',
    objectFit: 'contain',
    background: '#f8fafc',
  },

  // Processing
  processingState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '28px',
    background: '#eff6ff',
    borderRadius: '12px',
    marginTop: '20px',
  },
  progressBar: {
    width: '100%',
    height: '8px',
    background: '#dbeafe',
    borderRadius: '4px',
    marginBottom: '14px',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #2563eb, #3b82f6)',
    borderRadius: '4px',
    transition: 'width 0.3s',
  },
  processingNote: {
    fontSize: '12px',
    color: '#64748b',
    marginTop: '8px',
  },

  // OCR Results
  ocrResults: {
    marginTop: '24px',
    padding: '20px',
    background: '#f0fdf4',
    borderRadius: '14px',
    border: '1px solid #86efac',
  },
  ocrTitle: {
    fontSize: '15px',
    fontWeight: '700',
    color: '#166534',
    margin: '0 0 6px 0',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  ocrNote: {
    fontSize: '12px',
    color: '#15803d',
    marginBottom: '16px',
    padding: '8px 12px',
    background: '#dcfce7',
    borderRadius: '6px',
  },
  ocrGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '10px',
  },
  ocrItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 12px',
    background: '#fff',
    borderRadius: '8px',
    border: '1px solid #bbf7d0',
  },
  ocrItemName: {
    fontWeight: '600',
    color: '#1e293b',
    fontSize: '13px',
  },
  ocrItemValue: {
    color: '#475569',
    fontSize: '13px',
  },
  
  // Manual entry
  manualEntrySection: {
    marginTop: '20px',
    padding: '16px',
    background: '#f8fafc',
    borderRadius: '10px',
    border: '1px solid #e2e8f0',
  },
  manualEntryTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#475569',
    marginBottom: '12px',
  },
  manualEntryRow: {
    display: 'flex',
    gap: '10px',
    marginBottom: '10px',
  },
  manualInput: {
    padding: '10px 12px',
    border: '1px solid #e2e8f0',
    borderRadius: '6px',
    fontSize: '14px',
    outline: 'none',
    fontFamily: 'inherit',
  },
  addItemButton: {
    padding: '10px 16px',
    background: '#e2e8f0',
    color: '#475569',
    border: 'none',
    borderRadius: '6px',
    fontSize: '13px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};

// ============================================================
// ログイン画面
// ============================================================
function LoginView() {
  const { signup, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handlePasswordReset = async (e) => {
    e.preventDefault();
    if (!email) {
      setError('メールアドレスを入力してください');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await sendPasswordResetEmail(auth, email);
      setSuccess('パスワードリセットメールを送信しました。メールをご確認ください。');
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/user-not-found') {
        setError('このメールアドレスは登録されていません');
      } else if (err.code === 'auth/invalid-email') {
        setError('メールアドレスの形式が正しくありません');
      } else {
        setError('メール送信に失敗しました');
      }
    }

    setLoading(false);
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setError('メールアドレスとパスワードを入力してください');
      return;
    }
    if (password.length < 6) {
      setError('パスワードは6文字以上で入力してください');
      return;
    }

    setLoading(true);
    setError('');

    try {
      if (isRegistering) {
        await signup(email, password);
      } else {
        await login(email, password);
      }
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/user-not-found') {
        setError('ユーザーが見つかりません');
      } else if (err.code === 'auth/wrong-password') {
        setError('パスワードが正しくありません');
      } else if (err.code === 'auth/email-already-in-use') {
        setError('このメールアドレスは既に使用されています');
      } else if (err.code === 'auth/invalid-email') {
        setError('メールアドレスの形式が正しくありません');
      } else if (err.code === 'auth/email-not-allowed') {
        setError('このメールアドレスは登録が許可されていません。管理者にお問い合わせください。');
      } else {
        setError('認証エラーが発生しました');
      }
    }

    setLoading(false);
  };

  return (
    <div style={styles.authContainer}>
      <div style={styles.authCard}>
        <div style={styles.authHeader}>
          <div style={styles.logoIcon}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M8 14h12M14 8v12" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round"/>
              <circle cx="14" cy="14" r="5" stroke="#60a5fa" strokeWidth="2" fill="none"/>
            </svg>
          </div>
          <h1 style={styles.authTitle}>Clinical Data Registry</h1>
          <p style={styles.authSubtitle}>臨床データ管理システム</p>
        </div>

        {showPasswordReset ? (
          <form style={styles.authForm} onSubmit={handlePasswordReset}>
            <p style={{fontSize: '14px', color: '#6b7280', marginBottom: '16px', textAlign: 'center'}}>
              登録済みのメールアドレスを入力してください。<br/>パスワード再設定用のメールを送信します。
            </p>
            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>メールアドレス</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={styles.input}
                placeholder="your@email.com"
              />
            </div>
            {error && <p style={styles.errorText}>{error}</p>}
            {success && <p style={{color: '#059669', fontSize: '14px', marginBottom: '16px', textAlign: 'center'}}>{success}</p>}
            <button
              type="submit"
              style={{...styles.primaryButton, opacity: loading ? 0.7 : 1}}
              disabled={loading}
            >
              {loading ? '送信中...' : 'リセットメールを送信'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPasswordReset(false);
                setError('');
                setSuccess('');
              }}
              style={styles.linkButton}
            >
              ← ログイン画面に戻る
            </button>
          </form>
        ) : (
          <form style={styles.authForm} onSubmit={handleAuth}>
            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>メールアドレス</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={styles.input}
                placeholder="your@email.com"
              />
            </div>
            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>パスワード</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={styles.input}
                placeholder="••••••••"
              />
            </div>
            {error && <p style={styles.errorText}>{error}</p>}
            <button
              type="submit"
              style={{...styles.primaryButton, opacity: loading ? 0.7 : 1}}
              disabled={loading}
            >
              {loading ? '処理中...' : (isRegistering ? '新規登録' : 'ログイン')}
            </button>
            <button
              type="button"
              onClick={() => setIsRegistering(!isRegistering)}
              style={styles.linkButton}
            >
              {isRegistering ? 'アカウントをお持ちの方はこちら' : '新規登録はこちら'}
            </button>
            {!isRegistering && (
              <button
                type="button"
                onClick={() => {
                  setShowPasswordReset(true);
                  setError('');
                }}
                style={{...styles.linkButton, marginTop: '8px', fontSize: '13px', color: '#6b7280'}}
              >
                パスワードを忘れた方はこちら
              </button>
            )}
          </form>
        )}

        <div style={styles.authFooter}>
          <p style={styles.footerText}>
            🔒 データは暗号化されて保存されます<br/>
            患者の個人情報（氏名等）は保存されません
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 患者一覧画面
// ============================================================
function PatientsListView({ onSelectPatient }) {
  const { user, logout, isAdmin } = useAuth();
  const [patients, setPatients] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPatient, setNewPatient] = useState({
    diagnosis: '',
    group: '',
    onsetDate: '',
    memo: ''
  });
  const [loading, setLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormat, setExportFormat] = useState('long'); // 'long', 'wide', 'integrated'

  // 管理者パネル用state
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [allowedEmails, setAllowedEmails] = useState([]);
  const [newAllowedEmail, setNewAllowedEmail] = useState('');
  const [emailAllowlistEnabled, setEmailAllowlistEnabled] = useState(false);
  const [adminEmail, setAdminEmail] = useState('');
  const [isSettingAdmin, setIsSettingAdmin] = useState(false);

  // 分析機能用state
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  const [selectedPatientIds, setSelectedPatientIds] = useState([]);
  const [selectedItems, setSelectedItems] = useState([]);
  const [analysisData, setAnalysisData] = useState(null);
  const [availableItems, setAvailableItems] = useState([]);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);
  const [analysisRawData, setAnalysisRawData] = useState([]);
  const chartRef = useRef(null);
  const [showGroupComparison, setShowGroupComparison] = useState(false);
  const [availableGroups, setAvailableGroups] = useState([]);
  const [selectedGroup1, setSelectedGroup1] = useState('');
  const [selectedGroup2, setSelectedGroup2] = useState('');
  const [comparisonResults, setComparisonResults] = useState(null);
  const [dayRangeStart, setDayRangeStart] = useState('');
  const [dayRangeEnd, setDayRangeEnd] = useState('');

  // 統計解析用state
  const [showStatisticalAnalysis, setShowStatisticalAnalysis] = useState(false);
  const [statChartType, setStatChartType] = useState('boxplot'); // 'boxplot', 'violin', 'bar', 'scatter'
  const [statSelectedItem, setStatSelectedItem] = useState('');
  const [statSelectedItems, setStatSelectedItems] = useState([]); // 複数選択用
  const [statResults, setStatResults] = useState(null);
  const [showDataPoints, setShowDataPoints] = useState('black'); // 'black', 'white', 'none'
  const statisticalChartRef = useRef(null);

  // 患者一括インポート用state
  const [showBulkImportModal, setShowBulkImportModal] = useState(false);
  const [bulkImportData, setBulkImportData] = useState([]);
  const [isBulkImporting, setIsBulkImporting] = useState(false);

  // 検査データ一括インポート用state
  const [showBulkLabImportModal, setShowBulkLabImportModal] = useState(false);
  const [bulkLabImportData, setBulkLabImportData] = useState([]);
  const [bulkClinicalEventData, setBulkClinicalEventData] = useState([]);
  const [isBulkLabImporting, setIsBulkLabImporting] = useState(false);

  // Firestoreからリアルタイムでデータ取得
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'users', user.uid, 'patients'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const patientsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setPatients(patientsData);
      setLoading(false);
    });

    return unsubscribe;
  }, [user]);

  // 管理者設定を読み込み
  useEffect(() => {
    const loadAdminSettings = async () => {
      try {
        // 管理者情報を取得
        const adminDoc = await getDoc(doc(db, 'config', 'admin'));
        if (adminDoc.exists()) {
          setAdminEmail(adminDoc.data().email || '');
        }

        // 許可リスト設定を取得
        const settingsDoc = await getDoc(doc(db, 'config', 'settings'));
        if (settingsDoc.exists()) {
          setEmailAllowlistEnabled(settingsDoc.data().emailAllowlistEnabled || false);
        }

        // 許可メールリストを取得
        const allowedSnapshot = await getDocs(collection(db, 'allowedEmails'));
        const emails = allowedSnapshot.docs.map(d => ({
          id: d.id,
          email: d.data().email
        }));
        setAllowedEmails(emails);
      } catch (err) {
        console.error('Error loading admin settings:', err);
      }
    };

    if (user) {
      loadAdminSettings();
    }
  }, [user]);

  // 管理者として自分を設定（初回のみ）
  const setAsAdmin = async () => {
    setIsSettingAdmin(true);
    try {
      await setDoc(doc(db, 'config', 'admin'), {
        email: user.email,
        uid: user.uid,
        setAt: serverTimestamp()
      });
      setAdminEmail(user.email);
      window.location.reload(); // 管理者権限を反映
    } catch (err) {
      console.error('Error setting admin:', err);
      alert('管理者の設定に失敗しました');
    }
    setIsSettingAdmin(false);
  };

  // 許可リスト機能のON/OFF切り替え
  const toggleEmailAllowlist = async () => {
    try {
      const newValue = !emailAllowlistEnabled;
      await setDoc(doc(db, 'config', 'settings'), {
        emailAllowlistEnabled: newValue
      }, { merge: true });
      setEmailAllowlistEnabled(newValue);
    } catch (err) {
      console.error('Error toggling allowlist:', err);
    }
  };

  // 許可メールを追加
  const addAllowedEmail = async () => {
    if (!newAllowedEmail || !newAllowedEmail.includes('@')) {
      alert('有効なメールアドレスを入力してください');
      return;
    }

    try {
      const emailLower = newAllowedEmail.toLowerCase().trim();
      // 重複チェック
      if (allowedEmails.some(e => e.email === emailLower)) {
        alert('このメールアドレスは既に登録されています');
        return;
      }

      const docRef = await addDoc(collection(db, 'allowedEmails'), {
        email: emailLower,
        addedAt: serverTimestamp(),
        addedBy: user.email
      });

      setAllowedEmails([...allowedEmails, { id: docRef.id, email: emailLower }]);
      setNewAllowedEmail('');
    } catch (err) {
      console.error('Error adding allowed email:', err);
      alert('メールアドレスの追加に失敗しました');
    }
  };

  // 許可メールを削除
  const removeAllowedEmail = async (id) => {
    if (!confirm('このメールアドレスを許可リストから削除しますか？')) return;

    try {
      await deleteDoc(doc(db, 'allowedEmails', id));
      setAllowedEmails(allowedEmails.filter(e => e.id !== id));
    } catch (err) {
      console.error('Error removing allowed email:', err);
      alert('削除に失敗しました');
    }
  };

  const addPatient = async () => {
    if (!newPatient.diagnosis) return;

    try {
      await addDoc(collection(db, 'users', user.uid, 'patients'), {
        displayId: `P${Date.now().toString(36).toUpperCase()}`,
        diagnosis: newPatient.diagnosis,
        group: newPatient.group,
        onsetDate: newPatient.onsetDate,
        memo: newPatient.memo,
        createdAt: serverTimestamp(),
      });

      setNewPatient({ diagnosis: '', group: '', onsetDate: '', memo: '' });
      setShowAddModal(false);
    } catch (err) {
      console.error('Error adding patient:', err);
    }
  };

  // ============================================
  // 患者一括インポート機能
  // ============================================

  // 一括インポート用サンプルExcelダウンロード
  const downloadBulkImportSample = () => {
    const sampleData = [
      { PatientID: 'P-001', Diagnosis: '自己免疫性脳炎', Group: 'NMDAR', OnsetDate: '2024-01-15', Memo: '症例メモ' },
      { PatientID: 'P-002', Diagnosis: '自己免疫性脳炎', Group: 'NMDAR', OnsetDate: '2024-02-01', Memo: '' },
      { PatientID: 'P-003', Diagnosis: '自己免疫性脳炎', Group: 'LGI1', OnsetDate: '2024-01-20', Memo: '高齢発症' },
      { PatientID: 'P-004', Diagnosis: 'ウイルス性脳炎', Group: 'Control', OnsetDate: '2024-02-10', Memo: '' },
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sampleData);
    XLSX.utils.book_append_sheet(wb, ws, '患者リスト');

    // 説明シートを追加
    const instructions = [
      ['列名', '説明', '必須'],
      ['PatientID', '患者ID（例: P-001）', '○'],
      ['Diagnosis', '診断名', ''],
      ['Group', '群（比較分析用）', ''],
      ['OnsetDate', '発症日（YYYY-MM-DD形式）', ''],
      ['Memo', 'メモ・備考', ''],
    ];
    const wsInst = XLSX.utils.aoa_to_sheet(instructions);
    XLSX.utils.book_append_sheet(wb, wsInst, '説明');

    XLSX.writeFile(wb, 'patient_bulk_import_sample.xlsx');
  };

  const handleBulkImportFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const workbook = XLSX.read(event.target.result, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet);

        // カラム名の正規化
        const normalizedData = data.map((row, idx) => ({
          _rowNum: idx + 2,
          patientId: row['PatientID'] || row['患者ID'] || row['ID'] || `P${Date.now().toString(36).toUpperCase()}${idx}`,
          diagnosis: row['Diagnosis'] || row['診断名'] || row['病名'] || '',
          group: row['Group'] || row['群'] || '',
          onsetDate: normalizeDate(row['OnsetDate'] || row['発症日'] || ''),
          memo: row['Memo'] || row['メモ'] || row['備考'] || ''
        }));

        setBulkImportData(normalizedData);
      } catch (err) {
        console.error('Error parsing file:', err);
        alert('ファイルの読み込みに失敗しました');
      }
    };
    reader.readAsBinaryString(file);
  };

  // 日付の正規化
  const normalizeDate = (dateVal) => {
    if (!dateVal) return '';
    if (typeof dateVal === 'number') {
      // Excel serial date
      const date = new Date((dateVal - 25569) * 86400 * 1000);
      return date.toISOString().split('T')[0];
    }
    if (typeof dateVal === 'string') {
      // Try to parse
      const parsed = new Date(dateVal);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().split('T')[0];
      }
    }
    return String(dateVal);
  };

  const executeBulkImport = async () => {
    if (bulkImportData.length === 0) return;

    setIsBulkImporting(true);
    let successCount = 0;

    for (const row of bulkImportData) {
      if (!row.diagnosis) continue;

      try {
        await addDoc(collection(db, 'users', user.uid, 'patients'), {
          displayId: row.patientId,
          diagnosis: row.diagnosis,
          group: row.group,
          onsetDate: row.onsetDate,
          memo: row.memo,
          createdAt: serverTimestamp(),
        });
        successCount++;
      } catch (err) {
        console.error('Error importing patient:', err);
      }
    }

    alert(`${successCount}件の患者データをインポートしました`);
    setShowBulkImportModal(false);
    setBulkImportData([]);
    setIsBulkImporting(false);
  };

  // ============================================
  // 検査データ一括インポート機能
  // ============================================

  const handleBulkLabImportFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, { type: 'array' });

        const labResults = [];
        const clinicalEventResults = [];

        // 各シートを処理
        for (const sheetName of workbook.SheetNames) {
          // スキップするシート
          if (sheetName === '患者一覧' || sheetName === '説明' || sheetName === '患者情報' ||
              sheetName.includes('縦持ち') || sheetName.includes('サマリー') ||
              sheetName === '治療データ' || sheetName === '治療') continue;

          // 臨床経過データシート（発作頻度推移、臨床イベントなど）を検出
          if (sheetName.includes('発作') || sheetName.includes('頻度') || sheetName.includes('推移') ||
              sheetName.includes('経過') || sheetName.includes('イベント') || sheetName.includes('臨床')) {
            const eventData = parseClinicalEventSheet(workbook, sheetName);
            if (eventData.length > 0) {
              clinicalEventResults.push(...eventData);
            }
            continue;
          }

          const sheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

          // シート名または患者IDセルから患者IDを取得
          let patientId = sheetName;

          // 1行目に「患者ID」がある場合、その値を使用
          for (let i = 0; i < Math.min(5, jsonData.length); i++) {
            const row = jsonData[i];
            if (row && row[0] === '患者ID' && row[1]) {
              patientId = row[1].toString();
              break;
            }
          }

          // 対応する患者を検索
          const matchedPatient = patients.find(p =>
            p.displayId === patientId ||
            p.id === patientId ||
            p.displayId?.includes(patientId) ||
            patientId.includes(p.displayId || '')
          );

          // 検査データをパース
          const labData = parseLabDataFromSheet(workbook, sheetName);

          if (labData.length > 0) {
            labResults.push({
              sheetName,
              patientId,
              matchedPatient,
              labData,
              totalItems: labData.reduce((sum, d) => sum + d.data.length, 0)
            });
          }
        }

        setBulkLabImportData(labResults);
        setBulkClinicalEventData(clinicalEventResults);
      } catch (err) {
        console.error('Error parsing file:', err);
        alert('ファイルの読み込みに失敗しました');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // 臨床経過シートをパース（発作頻度推移、臨床症状推移など）
  const parseClinicalEventSheet = (workbook, sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (jsonData.length < 2) return [];

    const headerRow = jsonData[0];
    const results = [];

    // シンプルフォーマット（日付, イベントタイプ, 詳細）の検出
    if (headerRow[0] === '日付' && (headerRow[1] === 'イベントタイプ' || headerRow[1] === 'イベント種類')) {
      // シンプルフォーマット: 各行が1つのイベント
      const events = [];
      for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        if (!row || !row[0]) continue;
        events.push({
          date: normalizeDate(row[0]),
          eventType: row[1]?.toString() || 'その他',
          detail: row[2]?.toString() || ''
        });
      }
      if (events.length > 0) {
        // このシートのイベントを1つのグループとして返す
        results.push({
          patientId: sheetName,
          matchedPatient: null,
          eventType: 'multiple',
          events: events
        });
      }
      return results;
    }

    // ヘッダーから「症状」列のインデックスを検出
    let symptomColumnIndex = -1;
    let dataStartIndex = 2; // デフォルト: 3列目からデータ

    for (let i = 0; i < headerRow.length; i++) {
      const header = headerRow[i]?.toString() || '';
      if (header === '症状' || header === 'イベント' || header === 'イベント種類') {
        symptomColumnIndex = i;
        dataStartIndex = i + 1;
        break;
      }
    }

    // ヘッダーから時間ポイントを抽出
    const timePoints = [];
    for (let i = dataStartIndex; i < headerRow.length; i++) {
      if (headerRow[i]) {
        timePoints.push({ index: i, label: headerRow[i].toString() });
      }
    }

    // 症状名からイベントタイプへのマッピング
    const symptomToEventType = {
      '倦怠感': '副腎不全',
      '寒がり': '甲状腺機能低下',
      '便秘': 'その他',
      '動悸': '甲状腺機能亢進',
      '手指振戦': '甲状腺機能亢進',
      '発汗過多': '甲状腺機能亢進',
      '意識障害': '意識障害',
      '多尿': '尿崩症',
      '口渇': '尿崩症',
      '低血圧': '副腎不全',
      '食欲低下': '副腎不全',
      '発熱': '発熱',
      '頭痛': '頭痛',
      '低ナトリウム血症': '低ナトリウム血症',
      '高ナトリウム血症': '高ナトリウム血症',
      '高血糖': '高血糖',
      '低血糖': '低血糖',
      'てんかん発作': 'てんかん発作',
      '発作': 'てんかん発作',
    };

    // 各行を処理
    for (let rowIdx = 1; rowIdx < jsonData.length; rowIdx++) {
      const row = jsonData[rowIdx];
      if (!row || !row[0]) continue;

      const patientId = row[0].toString();

      // 対応する患者を検索
      const matchedPatient = patients.find(p =>
        p.displayId === patientId ||
        p.id === patientId ||
        p.displayId?.includes(patientId) ||
        patientId.includes(p.displayId || '')
      );

      // イベントタイプを決定
      let eventType = 'その他';
      let symptomName = '';

      if (symptomColumnIndex >= 0 && row[symptomColumnIndex]) {
        // 症状列がある場合はその値を使用
        symptomName = row[symptomColumnIndex].toString();
        eventType = symptomToEventType[symptomName] || symptomName;
      } else {
        // シート名から推測
        if (sheetName.includes('発作') || sheetName.includes('頻度')) eventType = 'てんかん発作';
        else if (sheetName.includes('意識')) eventType = '意識障害';
        else if (sheetName.includes('発熱')) eventType = '発熱';
      }

      // 各時間ポイントのデータを抽出
      const events = [];
      for (const tp of timePoints) {
        const value = row[tp.index];
        if (value !== undefined && value !== null && value !== '') {
          events.push({
            timeLabel: tp.label,
            value: value,
            eventType: eventType,
            symptomName: symptomName || eventType
          });
        }
      }

      if (events.length > 0) {
        results.push({
          sheetName,
          patientId,
          matchedPatient,
          events,
          eventType,
          symptomName: symptomName || eventType
        });
      }
    }

    return results;
  };

  // シートから検査データをパースする共通関数
  const parseLabDataFromSheet = (workbook, sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const specimenType = sheetName.includes('CSF') ? 'CSF' :
                         sheetName.includes('Serum') ? 'Serum' : '';

    let headerRowIndex = -1;
    for (let i = 0; i < Math.min(15, jsonData.length); i++) {
      const row = jsonData[i];
      if (row && row[0] === '検査項目') {
        headerRowIndex = i;
        break;
      }
    }

    if (headerRowIndex === -1) return [];

    const headerRow = jsonData[headerRowIndex];

    // 単位列を検出
    let unitColumnIndex = 1;
    for (let i = 1; i < Math.min(5, headerRow.length); i++) {
      if (headerRow[i] && headerRow[i].toString().includes('単位')) {
        unitColumnIndex = i;
        break;
      }
    }

    const dataStartIndex = unitColumnIndex + 1;

    // 日付列を検出
    const dateColumns = [];
    for (let i = dataStartIndex; i < headerRow.length; i++) {
      const headerValue = headerRow[i];
      if (!headerValue) continue;

      const headerStr = headerValue.toString();
      let formattedDate = '';
      let dayLabel = '';

      const dateMatch = headerStr.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/);
      if (dateMatch) {
        formattedDate = dateMatch[1].replace(/\//g, '-');
        const labelMatch = headerStr.split(/[\n\r]+/);
        dayLabel = labelMatch.length > 1 ? labelMatch[1].trim() : formattedDate;
      } else if (headerStr.startsWith('Day')) {
        dayLabel = headerStr;
        formattedDate = headerStr; // Day形式の場合は別途日付を取得する必要あり
      }

      if (formattedDate) {
        dateColumns.push({ index: i, day: dayLabel, date: formattedDate });
      }
    }

    // 検査データを抽出
    const labDataByDate = {};

    for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row || !row[0]) continue;

      const itemName = row[0].toString().trim();
      const unit = row[unitColumnIndex] ? row[unitColumnIndex].toString() : '';

      // スキップ条件：カテゴリ行、空行、ヘッダー行、日付パターン
      if (itemName.startsWith('【') || itemName === '' || itemName === '検査項目') continue;

      // 日付パターンをスキップ（様々な形式に対応）
      if (/\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2}/.test(itemName)) continue;  // 2024-01-01, 2024.01.01形式（文字列のどこかに含まれていればスキップ）
      if (/^Day\s*\d+/i.test(itemName)) continue;  // Day 1形式
      if (/^\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4}/.test(itemName)) continue;  // 01/01/2024形式
      if (/^\d+$/.test(itemName) && parseInt(itemName) > 30000) continue;  // Excelのシリアル日付
      if (/^(ベースライン|baseline|治療前|治療後|初診|入院|退院)/i.test(itemName)) continue;  // 時間ラベル
      if (/\d+[日週ヶ月年]後?/.test(itemName)) continue;  // 1ヶ月後などの時間ラベル（文字列のどこかに含まれていればスキップ）
      if (/^(基準値|単位|患者|診断|発症|採取|検体|参考値|正常値)/.test(itemName)) continue;  // ヘッダー関連
      if (/\r?\n/.test(itemName)) continue;  // 改行を含む（日付+ラベルの複合セル）
      // 日本語の日付形式
      if (/\d{1,2}月\d{1,2}日/.test(itemName)) continue;  // 1月1日形式
      if (/令和|平成|昭和/.test(itemName)) continue;  // 和暦

      for (const col of dateColumns) {
        const value = row[col.index];
        const numValue = parseFloat(String(value).replace(/,/g, ''));
        if (value !== undefined && value !== null && value !== '' && !isNaN(numValue)) {
          if (!labDataByDate[col.date]) {
            labDataByDate[col.date] = {
              date: col.date,
              day: col.day,
              specimen: specimenType,
              data: []
            };
          }
          labDataByDate[col.date].data.push({ item: itemName, value: numValue, unit: unit });
        }
      }
    }

    return Object.values(labDataByDate).sort((a, b) => a.date.localeCompare(b.date));
  };

  const executeBulkLabImport = async () => {
    if (bulkLabImportData.length === 0 && bulkClinicalEventData.length === 0) return;

    setIsBulkLabImporting(true);
    let labSuccessCount = 0;
    let labSkipCount = 0;
    let totalLabItems = 0;
    let eventSuccessCount = 0;

    // 検査データのインポート（重複チェック付き）
    for (const sheetData of bulkLabImportData) {
      if (!sheetData.matchedPatient) continue;

      const patientRef = sheetData.matchedPatient;

      // 既存の検査データを取得して重複チェック用セットを作成
      let existingLabDates = new Set();
      try {
        const existingSnapshot = await getDocs(
          collection(db, 'users', user.uid, 'patients', patientRef.id, 'labResults')
        );
        existingSnapshot.forEach(doc => {
          const data = doc.data();
          // 日付+検体タイプの組み合わせをキーにする
          existingLabDates.add(`${data.date}_${data.specimen || ''}`);
        });
      } catch (err) {
        console.error('Error fetching existing lab results:', err);
      }

      let importedCount = 0;
      for (const dayData of sheetData.labData) {
        try {
          // 重複チェック（同じ日付+同じ検体タイプは既に存在するかチェック）
          const labKey = `${dayData.date}_${dayData.specimen || ''}`;
          if (existingLabDates.has(labKey)) {
            labSkipCount++;
            continue; // 重複はスキップ
          }

          await addDoc(
            collection(db, 'users', user.uid, 'patients', patientRef.id, 'labResults'),
            {
              date: dayData.date,
              specimen: dayData.specimen || '',
              data: dayData.data,  // 配列形式で保存（通常のインポートと同じ形式）
              source: 'excel_bulk',
              createdAt: serverTimestamp()
            }
          );
          totalLabItems += dayData.data.length;
          labSuccessCount++;
          importedCount++;
          existingLabDates.add(labKey); // 新規追加したものも重複チェック対象に
        } catch (err) {
          console.error('Error importing lab data:', err);
        }
      }

      // 患者の検査件数を更新（実際にインポートした分のみ）
      if (importedCount > 0) {
        try {
          const currentLabCount = patientRef.labCount || 0;
          await updateDoc(doc(db, 'users', user.uid, 'patients', patientRef.id), {
            labCount: currentLabCount + importedCount
          });
        } catch (err) {
          console.error('Error updating lab count:', err);
        }
      }
    }

    // 臨床経過データのインポート（重複チェック付き）
    let eventSkipCount = 0;
    for (const eventData of bulkClinicalEventData) {
      if (!eventData.matchedPatient) continue;

      const patientRef = eventData.matchedPatient;
      const onsetDate = patientRef.onsetDate ? new Date(patientRef.onsetDate) : new Date();

      // 既存の臨床経過を取得して重複チェック用セットを作成
      let existingEvents = new Set();
      try {
        const existingSnapshot = await getDocs(
          collection(db, 'users', user.uid, 'patients', patientRef.id, 'clinicalEvents')
        );
        existingSnapshot.forEach(doc => {
          const data = doc.data();
          // 日付+イベントタイプの組み合わせをキーにする
          existingEvents.add(`${data.startDate}_${data.eventType}`);
        });
      } catch (err) {
        console.error('Error fetching existing events:', err);
      }

      for (const event of eventData.events) {
        try {
          let eventDate;
          let eventType = event.eventType || 'その他';
          let detail = event.detail || '';

          // 新フォーマット（日付が直接指定されている場合）
          if (event.date) {
            eventDate = new Date(event.date);
          } else if (event.timeLabel) {
            // 旧フォーマット（時間ラベルから日付を計算）
            eventDate = new Date(onsetDate);
            const label = event.timeLabel.toLowerCase();

            if (label.includes('ベースライン') || label.includes('baseline')) {
              // 発症日をそのまま使用
            } else if (label.includes('ヶ月後') || label.includes('ヵ月後')) {
              const months = parseInt(label.match(/(\d+)/)?.[1] || '0');
              eventDate.setMonth(eventDate.getMonth() + months);
            } else if (label.includes('週後')) {
              const weeks = parseInt(label.match(/(\d+)/)?.[1] || '0');
              eventDate.setDate(eventDate.getDate() + weeks * 7);
            } else if (label.includes('日後')) {
              const days = parseInt(label.match(/(\d+)/)?.[1] || '0');
              eventDate.setDate(eventDate.getDate() + days);
            }
            eventType = event.eventType || eventType;
            detail = event.severity ? `重症度: ${event.severity}` : '';
          } else {
            continue; // 日付情報がない場合はスキップ
          }

          const dateStr = eventDate.toISOString().split('T')[0];

          // 重複チェック（同じ日付+同じイベントタイプは既に存在するかチェック）
          const eventKey = `${dateStr}_${eventType}`;
          if (existingEvents.has(eventKey)) {
            eventSkipCount++;
            continue; // 重複はスキップ
          }

          // 頻度値を適切な形式に変換（旧フォーマットの場合のみ）
          let frequency = 'once';
          if (event.value) {
            const numValue = parseFloat(event.value);
            if (!isNaN(numValue)) {
              if (numValue >= 20) frequency = 'hourly';
              else if (numValue >= 7) frequency = 'several_daily';
              else if (numValue >= 3) frequency = 'daily';
              else if (numValue >= 1) frequency = 'several_weekly';
              else frequency = 'weekly';
            }
          }

          await addDoc(
            collection(db, 'users', user.uid, 'patients', patientRef.id, 'clinicalEvents'),
            {
              eventType: eventType,
              startDate: dateStr,
              frequency: frequency,
              note: detail || (event.timeLabel ? `${event.timeLabel}: ${event.value}回/週` : ''),
              createdAt: serverTimestamp()
            }
          );
          eventSuccessCount++;
          existingEvents.add(eventKey); // 新規追加したものも重複チェック対象に
        } catch (err) {
          console.error('Error importing clinical event:', err);
        }
      }
    }

    const messages = [];
    if (labSuccessCount > 0) messages.push(`検査データ ${labSuccessCount}件（${totalLabItems}項目）`);
    if (eventSuccessCount > 0) messages.push(`臨床経過 ${eventSuccessCount}件`);
    if (labSkipCount > 0 || eventSkipCount > 0) {
      const skipDetails = [];
      if (labSkipCount > 0) skipDetails.push(`検査${labSkipCount}件`);
      if (eventSkipCount > 0) skipDetails.push(`臨床経過${eventSkipCount}件`);
      messages.push(`重複スキップ: ${skipDetails.join('、')}`);
    }
    alert(`インポート完了: ${messages.join('、')}`);

    setShowBulkLabImportModal(false);
    setBulkLabImportData([]);
    setBulkClinicalEventData([]);
    setIsBulkLabImporting(false);
  };

  // ============================================
  // エクスポート機能
  // ============================================

  // CSVダウンロード用ヘルパー関数
  const downloadCSV = (data, headers, filename) => {
    const csvContent = [
      headers.join(','),
      ...data.map(row =>
        headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          if (typeof val === 'string' && (val.includes(',') || val.includes('\n') || val.includes('"'))) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        }).join(',')
      )
    ].join('\n');

    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 発症日からの日数を計算（汎用）
  const calcDays = (onsetDate, targetDate) => {
    if (!onsetDate || !targetDate) return '';
    const onset = new Date(onsetDate);
    const target = new Date(targetDate);
    return Math.ceil((target - onset) / (1000 * 60 * 60 * 24));
  };

  // ========================================
  // 統計解析ヘルパー関数
  // ========================================

  // 基本統計量
  const calculateStats = (arr) => {
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (n - 1);
    const sd = Math.sqrt(variance);
    const se = sd / Math.sqrt(n);
    const median = n % 2 === 0 ? (sorted[n/2 - 1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)];
    const q1 = sorted[Math.floor(n * 0.25)];
    const q3 = sorted[Math.floor(n * 0.75)];
    const iqr = q3 - q1;
    const min = sorted[0];
    const max = sorted[n - 1];
    const whiskerLow = Math.max(min, q1 - 1.5 * iqr);
    const whiskerHigh = Math.min(max, q3 + 1.5 * iqr);
    const outliers = sorted.filter(v => v < whiskerLow || v > whiskerHigh);

    return { n, mean, sd, se, median, q1, q3, iqr, min, max, whiskerLow, whiskerHigh, outliers, values: sorted };
  };

  // Shapiro-Wilk近似（簡易版）- 正規性検定
  const shapiroWilkTest = (arr) => {
    if (arr.length < 3 || arr.length > 50) {
      // サンプルサイズ制限
      return { W: null, pValue: null, isNormal: arr.length >= 30 }; // 大標本は正規近似
    }
    const n = arr.length;
    const sorted = [...arr].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / n;

    // 簡易的な正規性判定（歪度・尖度ベース）
    const m2 = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / n;
    const m3 = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 3), 0) / n;
    const m4 = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 4), 0) / n;
    const skewness = m3 / Math.pow(m2, 1.5);
    const kurtosis = m4 / Math.pow(m2, 2) - 3;

    // Jarque-Bera的な判定
    const jb = (n / 6) * (Math.pow(skewness, 2) + Math.pow(kurtosis, 2) / 4);
    const pValue = Math.exp(-jb / 2); // 簡易近似

    return { W: 1 - jb / 100, pValue, isNormal: pValue > 0.05, skewness, kurtosis };
  };

  // 独立2群のt検定
  const tTest = (group1, group2) => {
    const n1 = group1.length, n2 = group2.length;
    if (n1 < 2 || n2 < 2) return { t: null, pValue: null, df: null };

    const mean1 = group1.reduce((a, b) => a + b, 0) / n1;
    const mean2 = group2.reduce((a, b) => a + b, 0) / n2;
    const var1 = group1.reduce((acc, v) => acc + Math.pow(v - mean1, 2), 0) / (n1 - 1);
    const var2 = group2.reduce((acc, v) => acc + Math.pow(v - mean2, 2), 0) / (n2 - 1);

    // Welch's t-test
    const se = Math.sqrt(var1 / n1 + var2 / n2);
    const t = (mean1 - mean2) / se;
    const df = Math.pow(var1 / n1 + var2 / n2, 2) /
      (Math.pow(var1 / n1, 2) / (n1 - 1) + Math.pow(var2 / n2, 2) / (n2 - 1));

    // p値近似（t分布の近似）
    const x = df / (df + t * t);
    const pValue = 2 * (1 - betaIncomplete(df / 2, 0.5, x));

    return { t, pValue: Math.max(0.0001, Math.min(1, pValue)), df, mean1, mean2, se };
  };

  // Mann-Whitney U検定
  const mannWhitneyU = (group1, group2) => {
    const n1 = group1.length, n2 = group2.length;
    if (n1 < 2 || n2 < 2) return { U: null, pValue: null };

    // ランク付け
    const combined = [
      ...group1.map(v => ({ v, g: 1 })),
      ...group2.map(v => ({ v, g: 2 }))
    ].sort((a, b) => a.v - b.v);

    let rank = 1;
    for (let i = 0; i < combined.length; i++) {
      let j = i;
      while (j < combined.length - 1 && combined[j].v === combined[j + 1].v) j++;
      const avgRank = (rank + rank + j - i) / 2;
      for (let k = i; k <= j; k++) combined[k].rank = avgRank;
      rank += j - i + 1;
      i = j;
    }

    const R1 = combined.filter(c => c.g === 1).reduce((acc, c) => acc + c.rank, 0);
    const U1 = n1 * n2 + (n1 * (n1 + 1)) / 2 - R1;
    const U2 = n1 * n2 - U1;
    const U = Math.min(U1, U2);

    // 正規近似
    const mU = (n1 * n2) / 2;
    const sigmaU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
    const z = (U - mU) / sigmaU;
    const pValue = 2 * (1 - normalCDF(Math.abs(z)));

    return { U, z, pValue: Math.max(0.0001, pValue) };
  };

  // Kruskal-Wallis検定（3群以上の非パラメトリック検定）
  const kruskalWallisTest = (groups) => {
    if (groups.length < 2) return { H: null, pValue: null };

    const allValues = groups.flatMap((g, i) => g.map(v => ({ v, g: i })));
    allValues.sort((a, b) => a.v - b.v);

    // ランク付け
    let rank = 1;
    for (let i = 0; i < allValues.length; i++) {
      let j = i;
      while (j < allValues.length - 1 && allValues[j].v === allValues[j + 1].v) j++;
      const avgRank = (rank + rank + j - i) / 2;
      for (let k = i; k <= j; k++) allValues[k].rank = avgRank;
      rank += j - i + 1;
      i = j;
    }

    const N = allValues.length;
    const k = groups.length;
    let H = 0;
    for (let i = 0; i < k; i++) {
      const ni = groups[i].length;
      const Ri = allValues.filter(v => v.g === i).reduce((acc, v) => acc + v.rank, 0);
      H += (Ri * Ri) / ni;
    }
    H = (12 / (N * (N + 1))) * H - 3 * (N + 1);

    // カイ二乗分布で近似
    const df = k - 1;
    const pValue = 1 - chiSquareCDF(H, df);

    return { H, df, pValue: Math.max(0.0001, pValue) };
  };

  // ANOVA（一元配置分散分析）
  const oneWayANOVA = (groups) => {
    if (groups.length < 2) return { F: null, pValue: null };

    const allValues = groups.flat();
    const N = allValues.length;
    const k = groups.length;
    const grandMean = allValues.reduce((a, b) => a + b, 0) / N;

    // 群間変動
    let SSB = 0;
    groups.forEach(g => {
      const ni = g.length;
      const mi = g.reduce((a, b) => a + b, 0) / ni;
      SSB += ni * Math.pow(mi - grandMean, 2);
    });

    // 群内変動
    let SSW = 0;
    groups.forEach(g => {
      const mi = g.reduce((a, b) => a + b, 0) / g.length;
      g.forEach(v => {
        SSW += Math.pow(v - mi, 2);
      });
    });

    const dfB = k - 1;
    const dfW = N - k;
    const MSB = SSB / dfB;
    const MSW = SSW / dfW;
    const F = MSB / MSW;

    // F分布で近似
    const pValue = 1 - fDistributionCDF(F, dfB, dfW);

    return { F, dfB, dfW, pValue: Math.max(0.0001, pValue) };
  };

  // 正規分布CDF近似
  const normalCDF = (x) => {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  };

  // ベータ不完全関数近似
  const betaIncomplete = (a, b, x) => {
    if (x === 0 || x === 1) return x;
    const bt = Math.exp(
      lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x)
    );
    if (x < (a + 1) / (a + b + 2)) {
      return bt * betacf(a, b, x) / a;
    }
    return 1 - bt * betacf(b, a, 1 - x) / b;
  };

  // ベータ連分数
  const betacf = (a, b, x) => {
    const maxIt = 100, eps = 3e-7;
    let aa, c = 1, d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIt; m++) {
      const m2 = 2 * m;
      aa = m * (b - m) * x / ((a - 1 + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + 1 + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < eps) break;
    }
    return h;
  };

  // ログガンマ関数
  const lgamma = (x) => {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  };

  // カイ二乗CDF
  const chiSquareCDF = (x, df) => {
    if (x <= 0) return 0;
    return gammaIncomplete(df / 2, x / 2);
  };

  // 不完全ガンマ関数
  const gammaIncomplete = (a, x) => {
    if (x < a + 1) {
      let sum = 1 / a, term = 1 / a;
      for (let n = 1; n <= 100; n++) {
        term *= x / (a + n);
        sum += term;
        if (Math.abs(term) < 1e-10) break;
      }
      return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
    } else {
      let b = x + 1 - a, c = 1 / 1e-30, d = 1 / b, h = d;
      for (let i = 1; i <= 100; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b;
        if (Math.abs(d) < 1e-30) d = 1e-30;
        c = b + an / c;
        if (Math.abs(c) < 1e-30) c = 1e-30;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < 1e-10) break;
      }
      return 1 - h * Math.exp(-x + a * Math.log(x) - lgamma(a));
    }
  };

  // F分布CDF
  const fDistributionCDF = (f, d1, d2) => {
    if (f <= 0) return 0;
    const x = (d1 * f) / (d1 * f + d2);
    return betaIncomplete(d1 / 2, d2 / 2, x);
  };

  // 有意性マーク
  const getSignificanceMarker = (pValue) => {
    if (pValue < 0.001) return '***';
    if (pValue < 0.01) return '**';
    if (pValue < 0.05) return '*';
    return 'n.s.';
  };

  // エクスポート実行（形式選択後）
  const executeExport = async (format) => {
    if (patients.length === 0) {
      alert('エクスポートするデータがありません');
      return;
    }

    setIsExporting(true);
    setShowExportModal(false);

    try {
      // 全患者のデータを取得
      const allPatientData = [];

      for (const patient of patients) {
        const patientInfo = {
          id: patient.displayId,
          group: patient.group || '',
          diagnosis: patient.diagnosis || '',
          onsetDate: patient.onsetDate || '',
          labResults: [],
          treatments: [],
          events: []
        };

        // 検査データ
        const labQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
          orderBy('date', 'asc')
        );
        const labSnapshot = await getDocs(labQuery);

        labSnapshot.docs.forEach(labDoc => {
          const labData = labDoc.data();
          patientInfo.labResults.push({
            date: labData.date,
            specimen: labData.specimen || '',
            dayFromOnset: calcDays(patient.onsetDate, labData.date),
            items: labData.data || []
          });
        });

        // 治療薬データ
        const treatmentQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'treatments'),
          orderBy('startDate', 'asc')
        );
        const treatmentSnapshot = await getDocs(treatmentQuery);

        treatmentSnapshot.docs.forEach(treatDoc => {
          patientInfo.treatments.push(treatDoc.data());
        });

        // 臨床経過データ
        const eventQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
          orderBy('startDate', 'asc')
        );
        const eventSnapshot = await getDocs(eventQuery);

        eventSnapshot.docs.forEach(eventDoc => {
          patientInfo.events.push(eventDoc.data());
        });

        allPatientData.push(patientInfo);
      }

      const dateStr = new Date().toISOString().split('T')[0];

      if (format === 'long') {
        // ロング形式（従来形式）: 1行1検査項目
        exportLongFormat(allPatientData, dateStr);
      } else if (format === 'wide') {
        // ワイド形式: 患者×日付ごとに1行、検査項目を列に展開
        exportWideFormat(allPatientData, dateStr);
      } else if (format === 'integrated') {
        // 統合形式: 患者ごとに時系列でまとめた形式
        exportIntegratedFormat(allPatientData, dateStr);
      } else if (format === 'excel_by_sheet') {
        // Excel形式: 患者ごとにシートを分けた臨床形式
        exportExcelBySheet(allPatientData, dateStr);
      }

    } catch (err) {
      console.error('Export error:', err);
      alert('エクスポートに失敗しました');
    }

    setIsExporting(false);
  };

  // ロング形式エクスポート（従来形式）
  const exportLongFormat = (allPatientData, dateStr) => {
    const allLabData = [];
    const allTreatmentData = [];
    const allEventData = [];

    allPatientData.forEach(patient => {
      // 検査データ
      patient.labResults.forEach(lab => {
        lab.items.forEach(item => {
          allLabData.push({
            PatientID: patient.id,
            Group: patient.group,
            Diagnosis: patient.diagnosis,
            OnsetDate: patient.onsetDate,
            LabDate: lab.date,
            DayFromOnset: lab.dayFromOnset,
            Specimen: lab.specimen,
            Item: item.item,
            Value: item.value,
            Unit: item.unit || ''
          });
        });
      });

      // 治療薬データ
      patient.treatments.forEach(t => {
        allTreatmentData.push({
          PatientID: patient.id,
          Group: patient.group,
          Diagnosis: patient.diagnosis,
          OnsetDate: patient.onsetDate,
          Category: t.category || '',
          MedicationName: t.medicationName || '',
          Dosage: t.dosage || '',
          DosageUnit: t.dosageUnit || '',
          StartDate: t.startDate || '',
          StartDayFromOnset: calcDays(patient.onsetDate, t.startDate),
          EndDate: t.endDate || '',
          EndDayFromOnset: calcDays(patient.onsetDate, t.endDate),
          Note: t.note || ''
        });
      });

      // 臨床経過データ
      patient.events.forEach(e => {
        allEventData.push({
          PatientID: patient.id,
          Group: patient.group,
          Diagnosis: patient.diagnosis,
          OnsetDate: patient.onsetDate,
          EventType: e.eventType || '',
          StartDate: e.startDate || '',
          StartDayFromOnset: calcDays(patient.onsetDate, e.startDate),
          EndDate: e.endDate || '',
          EndDayFromOnset: calcDays(patient.onsetDate, e.endDate),
          JCS: e.jcs || '',
          Frequency: e.frequency || '',
          Presence: e.presence || '',
          Severity: e.severity || '',
          Note: e.note || ''
        });
      });
    });

    if (allLabData.length > 0) {
      const labHeaders = ['PatientID', 'Group', 'Diagnosis', 'OnsetDate', 'LabDate', 'DayFromOnset', 'Specimen', 'Item', 'Value', 'Unit'];
      downloadCSV(allLabData, labHeaders, `lab_data_long_${dateStr}.csv`);
    }

    if (allTreatmentData.length > 0) {
      const treatHeaders = ['PatientID', 'Group', 'Diagnosis', 'OnsetDate', 'Category', 'MedicationName', 'Dosage', 'DosageUnit', 'StartDate', 'StartDayFromOnset', 'EndDate', 'EndDayFromOnset', 'Note'];
      downloadCSV(allTreatmentData, treatHeaders, `treatment_data_${dateStr}.csv`);
    }

    if (allEventData.length > 0) {
      const eventHeaders = ['PatientID', 'Group', 'Diagnosis', 'OnsetDate', 'EventType', 'StartDate', 'StartDayFromOnset', 'EndDate', 'EndDayFromOnset', 'JCS', 'Frequency', 'Presence', 'Severity', 'Note'];
      downloadCSV(allEventData, eventHeaders, `clinical_events_${dateStr}.csv`);
    }

    const total = allLabData.length + allTreatmentData.length + allEventData.length;
    if (total === 0) {
      alert('エクスポートするデータがありません');
    } else {
      alert(`ロング形式エクスポート完了:\n・検査データ: ${allLabData.length}件\n・治療薬データ: ${allTreatmentData.length}件\n・臨床経過データ: ${allEventData.length}件`);
    }
  };

  // ワイド形式エクスポート: 患者×日付ごとに1行、検査項目を列に
  const exportWideFormat = (allPatientData, dateStr) => {
    // 全検査項目を収集
    const allItems = new Set();
    allPatientData.forEach(patient => {
      patient.labResults.forEach(lab => {
        lab.items.forEach(item => {
          allItems.add(item.item);
        });
      });
    });
    const itemList = Array.from(allItems).sort();

    if (itemList.length === 0) {
      alert('検査データがありません');
      return;
    }

    // ワイド形式データ作成
    const wideData = [];
    allPatientData.forEach(patient => {
      patient.labResults.forEach(lab => {
        const row = {
          PatientID: patient.id,
          Group: patient.group,
          Diagnosis: patient.diagnosis,
          OnsetDate: patient.onsetDate,
          LabDate: lab.date,
          DayFromOnset: lab.dayFromOnset,
          Specimen: lab.specimen
        };

        // 検査項目を列に展開
        itemList.forEach(itemName => {
          const found = lab.items.find(i => i.item === itemName);
          row[itemName] = found ? found.value : '';
        });

        wideData.push(row);
      });
    });

    // 患者ID→日付順でソート
    wideData.sort((a, b) => {
      if (a.PatientID !== b.PatientID) return a.PatientID.localeCompare(b.PatientID);
      return (a.LabDate || '').localeCompare(b.LabDate || '');
    });

    const headers = ['PatientID', 'Group', 'Diagnosis', 'OnsetDate', 'LabDate', 'DayFromOnset', 'Specimen', ...itemList];
    downloadCSV(wideData, headers, `lab_data_wide_${dateStr}.csv`);

    alert(`ワイド形式エクスポート完了:\n・${wideData.length}行 × ${itemList.length}検査項目`);
  };

  // 統合形式エクスポート: 患者ごとに全データを時系列でまとめる
  const exportIntegratedFormat = (allPatientData, dateStr) => {
    const integratedData = [];

    allPatientData.forEach(patient => {
      // 全イベントを時系列でまとめる
      const timeline = [];

      // 検査データ
      patient.labResults.forEach(lab => {
        lab.items.forEach(item => {
          timeline.push({
            date: lab.date,
            dayFromOnset: lab.dayFromOnset,
            type: '検査',
            category: lab.specimen || '血液',
            name: item.item,
            value: item.value,
            unit: item.unit || '',
            startDate: lab.date,
            endDate: '',
            note: ''
          });
        });
      });

      // 治療薬データ
      patient.treatments.forEach(t => {
        timeline.push({
          date: t.startDate,
          dayFromOnset: calcDays(patient.onsetDate, t.startDate),
          type: '治療',
          category: t.category || '',
          name: t.medicationName || '',
          value: t.dosage || '',
          unit: t.dosageUnit || '',
          startDate: t.startDate || '',
          endDate: t.endDate || '',
          note: t.note || ''
        });
      });

      // 臨床経過データ
      patient.events.forEach(e => {
        timeline.push({
          date: e.startDate,
          dayFromOnset: calcDays(patient.onsetDate, e.startDate),
          type: '臨床経過',
          category: e.eventType || '',
          name: e.jcs ? `JCS ${e.jcs}` : (e.frequency || e.presence || ''),
          value: e.severity || '',
          unit: '',
          startDate: e.startDate || '',
          endDate: e.endDate || '',
          note: e.note || ''
        });
      });

      // 日付順でソート
      timeline.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      // データ行に変換
      timeline.forEach(item => {
        integratedData.push({
          PatientID: patient.id,
          Group: patient.group,
          Diagnosis: patient.diagnosis,
          OnsetDate: patient.onsetDate,
          Date: item.date,
          DayFromOnset: item.dayFromOnset,
          DataType: item.type,
          Category: item.category,
          Name: item.name,
          Value: item.value,
          Unit: item.unit,
          StartDate: item.startDate,
          EndDate: item.endDate,
          Note: item.note
        });
      });
    });

    if (integratedData.length === 0) {
      alert('エクスポートするデータがありません');
      return;
    }

    const headers = ['PatientID', 'Group', 'Diagnosis', 'OnsetDate', 'Date', 'DayFromOnset', 'DataType', 'Category', 'Name', 'Value', 'Unit', 'StartDate', 'EndDate', 'Note'];
    downloadCSV(integratedData, headers, `integrated_data_${dateStr}.csv`);

    alert(`統合形式エクスポート完了:\n・${integratedData.length}件のデータ（検査・治療・臨床経過を統合）`);
  };

  // Excel形式エクスポート: 患者ごとにシートを分けた臨床形式
  const exportExcelBySheet = (allPatientData, dateStr) => {
    // XLSXワークブック作成
    const wb = XLSX.utils.book_new();

    // 1. 患者情報シート
    const patientInfoData = allPatientData.map(p => ({
      PatientID: p.id,
      Diagnosis: p.diagnosis,
      Group: p.group,
      OnsetDate: p.onsetDate
    }));
    const patientInfoSheet = XLSX.utils.json_to_sheet(patientInfoData);
    XLSX.utils.book_append_sheet(wb, patientInfoSheet, '患者情報');

    // 2. 患者ごと×検体ごとにシートを作成
    allPatientData.forEach(patient => {
      if (patient.labResults.length === 0) return;

      // 検体タイプでグループ化
      const specimenGroups = {};
      patient.labResults.forEach(lab => {
        const specimen = lab.specimen || 'Other';
        if (!specimenGroups[specimen]) {
          specimenGroups[specimen] = [];
        }
        specimenGroups[specimen].push(lab);
      });

      // 各検体タイプごとにシート作成
      Object.entries(specimenGroups).forEach(([specimen, labs]) => {
        // 日付順にソート
        labs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        // 全検査項目を収集
        const allItems = new Set();
        labs.forEach(lab => {
          lab.items.forEach(item => allItems.add(item.item));
        });
        const itemList = Array.from(allItems).sort();

        if (itemList.length === 0) return;

        // Day番号を計算
        const dayLabels = labs.map((lab, idx) => {
          const day = lab.dayFromOnset;
          return day !== '' && day !== null ? `Day${day}` : `Day${idx + 1}`;
        });

        // シートデータを構築
        const sheetData = [];

        // ヘッダー行: Patient ID と検体タイプ
        const headerRow = [`Patient ID: ${patient.id}`, '', `検体: ${specimen}`];
        labs.forEach(() => headerRow.push(''));
        sheetData.push(headerRow);

        // 空行
        sheetData.push([]);

        // 日付ラベル行
        const dayRow = ['検査項目', '単位', ...dayLabels];
        sheetData.push(dayRow);

        // 実際の日付行
        const dateRow = ['採取日', 'YYYY/MM/DD', ...labs.map(lab => lab.date || '')];
        sheetData.push(dateRow);

        // 空行
        sheetData.push([]);

        // 検査項目ごとにデータ行を追加
        itemList.forEach(itemName => {
          // 単位を取得（最初に見つかったものを使用）
          let unit = '';
          for (const lab of labs) {
            const found = lab.items.find(i => i.item === itemName);
            if (found && found.unit) {
              unit = found.unit;
              break;
            }
          }

          // 各日付の値を取得
          const values = labs.map(lab => {
            const found = lab.items.find(i => i.item === itemName);
            return found ? found.value : '';
          });

          sheetData.push([itemName, unit, ...values]);
        });

        // シート名（最大31文字、特殊文字除去）
        let sheetName = `${patient.id}_${specimen}`;
        sheetName = sheetName.replace(/[\\\/\?\*\[\]:]/g, '_').substring(0, 31);

        const ws = XLSX.utils.aoa_to_sheet(sheetData);

        // 列幅設定
        ws['!cols'] = [
          { wch: 15 }, // 検査項目
          { wch: 12 }, // 単位
          ...labs.map(() => ({ wch: 12 })) // 各日付
        ];

        XLSX.utils.book_append_sheet(wb, ws, sheetName);
      });
    });

    // 3. 治療薬シート
    const treatmentData = [];
    allPatientData.forEach(patient => {
      patient.treatments.forEach(t => {
        treatmentData.push({
          PatientID: patient.id,
          Category: t.category || '',
          Medication: t.medicationName || '',
          Dosage: t.dosage || '',
          Unit: t.dosageUnit || '',
          StartDate: t.startDate || '',
          StartDay: calcDays(patient.onsetDate, t.startDate),
          EndDate: t.endDate || '',
          EndDay: calcDays(patient.onsetDate, t.endDate),
          Note: t.note || ''
        });
      });
    });
    if (treatmentData.length > 0) {
      const treatmentSheet = XLSX.utils.json_to_sheet(treatmentData);
      XLSX.utils.book_append_sheet(wb, treatmentSheet, '治療薬');
    }

    // 4. 臨床経過シート
    const eventData = [];
    allPatientData.forEach(patient => {
      patient.events.forEach(e => {
        eventData.push({
          PatientID: patient.id,
          EventType: e.eventType || '',
          StartDate: e.startDate || '',
          StartDay: calcDays(patient.onsetDate, e.startDate),
          EndDate: e.endDate || '',
          EndDay: calcDays(patient.onsetDate, e.endDate),
          JCS: e.jcs || '',
          Frequency: e.frequency || '',
          Severity: e.severity || '',
          Note: e.note || ''
        });
      });
    });
    if (eventData.length > 0) {
      const eventSheet = XLSX.utils.json_to_sheet(eventData);
      XLSX.utils.book_append_sheet(wb, eventSheet, '臨床経過');
    }

    // ファイル出力
    XLSX.writeFile(wb, `clinical_data_${dateStr}.xlsx`);

    const sheetCount = wb.SheetNames.length;
    alert(`Excel形式エクスポート完了:\n・${sheetCount}シート（患者情報 + 患者別検査データ + 治療薬 + 臨床経過）`);
  };

  // 従来のexportAllData関数（後方互換性のため残す）
  const exportAllData = () => {
    setShowExportModal(true);
  };

  // 分析モーダルを開く際にデータを読み込む
  const openAnalysisModal = async () => {
    setShowAnalysisModal(true);
    setIsLoadingAnalysis(true);
    setSelectedPatientIds([]);
    setSelectedItems([]);
    setAnalysisData(null);
    setShowGroupComparison(false);
    setComparisonResults(null);
    setSelectedGroup1('');
    setSelectedGroup2('');

    // 全患者の検査項目と群を収集
    const itemsSet = new Set();
    const groupsSet = new Set();

    for (const patient of patients) {
      if (patient.group) groupsSet.add(patient.group);

      const labQuery = query(
        collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
        orderBy('date', 'asc')
      );
      const labSnapshot = await getDocs(labQuery);

      labSnapshot.docs.forEach(labDoc => {
        const labData = labDoc.data();
        if (labData.data && Array.isArray(labData.data)) {
          labData.data.forEach(item => {
            if (item.item) {
              const itemName = item.item.toString().trim();
              // 日付パターンをスキップ（誤ってインポートされたデータを除外）
              if (/\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2}/.test(itemName)) return;
              if (/^Day\s*\d+/i.test(itemName)) return;
              if (/^\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4}/.test(itemName)) return;
              if (/^\d+$/.test(itemName) && parseInt(itemName) > 30000) return;
              if (/^(ベースライン|baseline|治療前|治療後|初診|入院|退院)/i.test(itemName)) return;
              if (/\d+[日週ヶ月年]後?/.test(itemName)) return;
              if (/^(基準値|単位|患者|診断|発症|採取|検体|参考値|正常値)/.test(itemName)) return;
              if (/\r?\n/.test(itemName)) return;
              if (/\d{1,2}月\d{1,2}日/.test(itemName)) return;
              if (/令和|平成|昭和/.test(itemName)) return;
              itemsSet.add(item.item);
            }
          });
        }
      });
    }

    setAvailableItems(Array.from(itemsSet).sort());
    setAvailableGroups(Array.from(groupsSet).sort());
    setIsLoadingAnalysis(false);
  };

  // 分析データを生成
  const generateAnalysisData = async () => {
    if (selectedPatientIds.length === 0 || selectedItems.length === 0) {
      alert('患者と項目を選択してください');
      return;
    }

    setIsLoadingAnalysis(true);

    const selectedPatientsData = patients.filter(p => selectedPatientIds.includes(p.id));
    const rawDataRows = []; // CSV用の生データ
    const colors = [
      '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
      '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'
    ];

    // 項目ごとにデータをグループ化
    const chartDataByItem = {};
    selectedItems.forEach(item => {
      chartDataByItem[item] = {
        datasets: [],
        unit: ''
      };
    });

    let patientColorIndex = 0;

    for (const patient of selectedPatientsData) {
      const labQuery = query(
        collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
        orderBy('date', 'asc')
      );
      const labSnapshot = await getDocs(labQuery);
      const patientColor = colors[patientColorIndex % colors.length];

      for (const itemName of selectedItems) {
        const dataPoints = [];
        let itemUnit = '';

        labSnapshot.docs.forEach(labDoc => {
          const labData = labDoc.data();
          const labDate = labData.date;

          // 発症日からの日数を計算
          let dayFromOnset = null;
          if (patient.onsetDate && labDate) {
            const onset = new Date(patient.onsetDate);
            const lab = new Date(labDate);
            const diffTime = lab - onset;
            dayFromOnset = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          }

          if (labData.data && Array.isArray(labData.data)) {
            const item = labData.data.find(d => d.item === itemName);
            if (item && dayFromOnset !== null) {
              dataPoints.push({
                x: dayFromOnset,
                y: parseFloat(item.value) || 0
              });
              if (item.unit) itemUnit = item.unit;
              // CSV用生データを追加
              rawDataRows.push({
                PatientID: patient.displayId,
                Group: patient.group || '',
                Diagnosis: patient.diagnosis || '',
                OnsetDate: patient.onsetDate || '',
                LabDate: labDate,
                DayFromOnset: dayFromOnset,
                Item: itemName,
                Value: item.value,
                Unit: item.unit || ''
              });
            }
          }
        });

        if (dataPoints.length > 0) {
          // Sort by x (day from onset)
          dataPoints.sort((a, b) => a.x - b.x);

          chartDataByItem[itemName].datasets.push({
            label: `${patient.displayId}${patient.group ? ` (${patient.group})` : ''}`,
            data: dataPoints,
            borderColor: patientColor,
            backgroundColor: patientColor + '40',
            tension: 0.1,
            pointRadius: 5,
            pointHoverRadius: 7,
          });
          if (itemUnit) chartDataByItem[itemName].unit = itemUnit;
        }
      }
      patientColorIndex++;
    }

    // 項目ごとのチャートデータを配列に変換
    const chartsArray = selectedItems
      .filter(item => chartDataByItem[item].datasets.length > 0)
      .map(item => {
        const itemData = chartDataByItem[item];
        const allDays = new Set();
        itemData.datasets.forEach(ds => {
          ds.data.forEach(point => allDays.add(point.x));
        });
        const sortedDays = Array.from(allDays).sort((a, b) => a - b);

        return {
          itemName: item,
          unit: itemData.unit,
          labels: sortedDays,
          datasets: itemData.datasets
        };
      });

    setAnalysisData(chartsArray);
    setAnalysisRawData(rawDataRows);

    setIsLoadingAnalysis(false);
  };

  // 分析データをCSVエクスポート
  const exportAnalysisCSV = () => {
    if (analysisRawData.length === 0) {
      alert('エクスポートするデータがありません');
      return;
    }

    const headers = ['PatientID', 'Group', 'Diagnosis', 'OnsetDate', 'LabDate', 'DayFromOnset', 'Item', 'Value', 'Unit'];
    const csvContent = [
      headers.join(','),
      ...analysisRawData.map(row =>
        headers.map(h => {
          const val = row[h];
          if (typeof val === 'string' && (val.includes(',') || val.includes('\n') || val.includes('"'))) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        }).join(',')
      )
    ].join('\n');

    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analysis_data_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // グラフを画像としてエクスポート
  const exportChartImage = () => {
    if (chartRef.current) {
      const url = chartRef.current.toBase64Image();
      const a = document.createElement('a');
      a.href = url;
      a.download = `analysis_chart_${new Date().toISOString().split('T')[0]}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  // 基本統計関数（群間比較用）
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const std = (arr) => {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((acc, val) => acc + Math.pow(val - m, 2), 0) / (arr.length - 1));
  };

  // 群間比較を実行
  // 発症日からの日数を計算するヘルパー関数
  const calcDayFromOnset = (patient, labDate) => {
    if (!patient.onsetDate || !labDate) return null;
    const onset = new Date(patient.onsetDate);
    const lab = new Date(labDate);
    return Math.ceil((lab - onset) / (1000 * 60 * 60 * 24));
  };

  // 日数フィルタをチェック
  const isInDayRange = (dayFromOnset) => {
    if (dayFromOnset === null) return false;
    const start = dayRangeStart !== '' ? parseInt(dayRangeStart) : null;
    const end = dayRangeEnd !== '' ? parseInt(dayRangeEnd) : null;

    if (start === null && end === null) return true; // フィルタなし
    if (start !== null && dayFromOnset < start) return false;
    if (end !== null && dayFromOnset > end) return false;
    return true;
  };

  const runGroupComparison = async () => {
    if (!selectedGroup1 || !selectedGroup2 || selectedItems.length === 0) {
      alert('2つの群と検査項目を選択してください');
      return;
    }

    setIsLoadingAnalysis(true);

    const group1Patients = patients.filter(p => p.group === selectedGroup1);
    const group2Patients = patients.filter(p => p.group === selectedGroup2);

    const results = [];

    for (const itemName of selectedItems) {
      const group1Data = []; // { id, value, date, day }
      const group2Data = []; // { id, value, date, day }

      // Group 1のデータ収集
      for (const patient of group1Patients) {
        const labQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
          orderBy('date', 'asc')
        );
        const labSnapshot = await getDocs(labQuery);

        labSnapshot.docs.forEach(labDoc => {
          const labData = labDoc.data();
          const labDate = labData.date;
          const dayFromOnset = calcDayFromOnset(patient, labDate);

          // 日数フィルタをチェック
          if (!isInDayRange(dayFromOnset)) return;

          if (labData.data && Array.isArray(labData.data)) {
            const item = labData.data.find(d => d.item === itemName);
            if (item && !isNaN(parseFloat(item.value))) {
              group1Data.push({
                id: patient.displayId,
                value: parseFloat(item.value),
                date: labDate,
                day: dayFromOnset
              });
            }
          }
        });
      }

      // Group 2のデータ収集
      for (const patient of group2Patients) {
        const labQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
          orderBy('date', 'asc')
        );
        const labSnapshot = await getDocs(labQuery);

        labSnapshot.docs.forEach(labDoc => {
          const labData = labDoc.data();
          const labDate = labData.date;
          const dayFromOnset = calcDayFromOnset(patient, labDate);

          // 日数フィルタをチェック
          if (!isInDayRange(dayFromOnset)) return;

          if (labData.data && Array.isArray(labData.data)) {
            const item = labData.data.find(d => d.item === itemName);
            if (item && !isNaN(parseFloat(item.value))) {
              group2Data.push({
                id: patient.displayId,
                value: parseFloat(item.value),
                date: labDate,
                day: dayFromOnset
              });
            }
          }
        });
      }

      // 数値のみの配列を抽出（統計計算用）
      const group1Values = group1Data.map(d => d.value);
      const group2Values = group2Data.map(d => d.value);

      if (group1Values.length > 0 && group2Values.length > 0) {
        const tResult = tTest(group1Values, group2Values);
        const mwResult = mannWhitneyU(group1Values, group2Values);

        results.push({
          item: itemName,
          group1: {
            n: group1Values.length,
            mean: mean(group1Values).toFixed(2),
            std: group1Values.length > 1 ? std(group1Values).toFixed(2) : '-',
            median: [...group1Values].sort((a, b) => a - b)[Math.floor(group1Values.length / 2)].toFixed(2),
            values: [...group1Values],
            data: [...group1Data] // ID付きデータも保存
          },
          group2: {
            n: group2Values.length,
            mean: mean(group2Values).toFixed(2),
            std: group2Values.length > 1 ? std(group2Values).toFixed(2) : '-',
            median: [...group2Values].sort((a, b) => a - b)[Math.floor(group2Values.length / 2)].toFixed(2),
            values: [...group2Values],
            data: [...group2Data] // ID付きデータも保存
          },
          tTest: tResult,
          mannWhitney: mwResult
        });
      }
    }

    setComparisonResults(results);
    setIsLoadingAnalysis(false);
  };

  // 統計結果をCSVエクスポート
  const exportComparisonCSV = () => {
    if (!comparisonResults || comparisonResults.length === 0) return;

    const headers = [
      'Item',
      `${selectedGroup1}_n`, `${selectedGroup1}_mean`, `${selectedGroup1}_SD`, `${selectedGroup1}_median`,
      `${selectedGroup2}_n`, `${selectedGroup2}_mean`, `${selectedGroup2}_SD`, `${selectedGroup2}_median`,
      't_statistic', 't_df', 't_p_value', 't_significant',
      'U_statistic', 'U_z', 'U_p_value', 'U_significant'
    ];

    const rows = comparisonResults.map(r => [
      r.item,
      r.group1.n, r.group1.mean, r.group1.std, r.group1.median,
      r.group2.n, r.group2.mean, r.group2.std, r.group2.median,
      r.tTest.t || '', r.tTest.df || '', r.tTest.p || '', r.tTest.significant ? 'Yes' : 'No',
      r.mannWhitney.U || '', r.mannWhitney.z || '', r.mannWhitney.p || '', r.mannWhitney.significant ? 'Yes' : 'No'
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dayRangeStr = (dayRangeStart !== '' || dayRangeEnd !== '')
      ? `_Day${dayRangeStart || '0'}-${dayRangeEnd || 'end'}`
      : '';
    a.download = `group_comparison_${selectedGroup1}_vs_${selectedGroup2}${dayRangeStr}_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 患者選択トグル
  const togglePatientSelection = (patientId) => {
    setSelectedPatientIds(prev =>
      prev.includes(patientId)
        ? prev.filter(id => id !== patientId)
        : [...prev, patientId]
    );
  };

  // 項目選択トグル
  const toggleItemSelection = (itemName) => {
    setSelectedItems(prev =>
      prev.includes(itemName)
        ? prev.filter(i => i !== itemName)
        : [...prev, itemName]
    );
  };

  if (loading) {
    return (
      <div style={styles.mainContainer}>
        <div style={{...styles.emptyState, padding: '100px'}}>
          読み込み中...
        </div>
      </div>
    );
  }

  return (
    <div style={styles.mainContainer}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.headerTitle}>患者一覧</h1>
          <span style={styles.headerBadge}>{patients.length} 件</span>
        </div>
        <div style={styles.headerRight}>
          <span style={styles.userInfo}>{user?.email}</span>
          <a
            href="/manual.html"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              ...styles.logoutButton,
              backgroundColor: '#0ea5e9',
              marginRight: '8px',
              textDecoration: 'none',
              display: 'inline-block'
            }}
          >
            📖 操作ガイド
          </a>
          {(isAdmin || !adminEmail) && (
            <button
              onClick={() => setShowAdminPanel(true)}
              style={{
                ...styles.logoutButton,
                backgroundColor: '#7c3aed',
                marginRight: '8px'
              }}
            >
              ⚙️ 管理
            </button>
          )}
          <button onClick={logout} style={styles.logoutButton}>
            ログアウト
          </button>
        </div>
      </header>

      <main style={styles.content}>
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <button onClick={() => setShowAddModal(true)} style={styles.addButton}>
            <span style={styles.addIcon}>+</span>
            新規患者登録
          </button>
          <button
            onClick={exportAllData}
            disabled={isExporting || patients.length === 0}
            style={{
              ...styles.addButton,
              backgroundColor: patients.length === 0 ? '#ccc' : '#28a745',
              opacity: isExporting ? 0.7 : 1,
              cursor: isExporting || patients.length === 0 ? 'not-allowed' : 'pointer'
            }}
          >
            {isExporting ? 'エクスポート中...' : '📊 CSVエクスポート'}
          </button>
          <button
            onClick={openAnalysisModal}
            disabled={patients.length === 0}
            style={{
              ...styles.addButton,
              backgroundColor: patients.length === 0 ? '#ccc' : '#8b5cf6',
              cursor: patients.length === 0 ? 'not-allowed' : 'pointer'
            }}
          >
            📈 経時データ分析
          </button>
          <button
            onClick={() => setShowBulkImportModal(true)}
            style={{
              ...styles.addButton,
              backgroundColor: '#f59e0b'
            }}
          >
            📥 患者一括登録
          </button>
          <button
            onClick={() => setShowBulkLabImportModal(true)}
            style={{
              ...styles.addButton,
              backgroundColor: '#8b5cf6'
            }}
          >
            📊 データ一括登録
          </button>
        </div>

        {patients.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>📋</div>
            <p>登録された患者はまだいません</p>
            <p style={styles.emptyHint}>「新規患者登録」から始めましょう</p>
          </div>
        ) : (
          <div style={styles.patientGrid}>
            {patients.map((patient) => (
              <div
                key={patient.id}
                style={styles.patientCard}
                onClick={() => onSelectPatient(patient)}
                onMouseOver={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 8px 25px rgba(0,0,0,0.1)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)';
                }}
              >
                <div style={styles.patientCardHeader}>
                  <span style={styles.patientId}>{patient.displayId}</span>
                  <span style={styles.labCount}>
                    検査 {patient.labCount || 0} 件
                  </span>
                </div>
                <h3 style={styles.patientDiagnosis}>{patient.diagnosis}</h3>
                <div style={styles.patientMeta}>
                  <span>発症日: {patient.onsetDate || '未設定'}</span>
                </div>
                {patient.memo && (
                  <p style={styles.patientMemo}>{patient.memo}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      {/* 新規患者登録モーダル */}
      {showAddModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <h2 style={styles.modalTitle}>新規患者登録</h2>
            <p style={styles.modalNote}>
              ⚠️ 個人情報保護のため、患者氏名は登録できません
            </p>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>病名 / 診断名 *</label>
              <input
                type="text"
                value={newPatient.diagnosis}
                onChange={(e) => setNewPatient({...newPatient, diagnosis: e.target.value})}
                style={styles.input}
                placeholder="例: マイコプラズマ脳炎"
              />
            </div>

            <div style={{...styles.inputGroup, marginTop: '16px'}}>
              <label style={styles.inputLabel}>群（Group）</label>
              <input
                type="text"
                value={newPatient.group}
                onChange={(e) => setNewPatient({...newPatient, group: e.target.value})}
                style={styles.input}
                placeholder="例: Mycoplasma, Viral, Control"
              />
            </div>

            <div style={{...styles.inputGroup, marginTop: '16px'}}>
              <label style={styles.inputLabel}>発症日</label>
              <input
                type="date"
                value={newPatient.onsetDate}
                onChange={(e) => setNewPatient({...newPatient, onsetDate: e.target.value})}
                style={styles.input}
              />
            </div>

            <div style={{...styles.inputGroup, marginTop: '16px'}}>
              <label style={styles.inputLabel}>メモ</label>
              <textarea
                value={newPatient.memo}
                onChange={(e) => setNewPatient({...newPatient, memo: e.target.value})}
                style={{...styles.input, minHeight: '100px', resize: 'vertical'}}
                placeholder="経過や特記事項など"
              />
            </div>

            <div style={styles.modalActions}>
              <button onClick={() => setShowAddModal(false)} style={styles.cancelButton}>
                キャンセル
              </button>
              <button 
                onClick={addPatient} 
                style={{...styles.primaryButton, opacity: !newPatient.diagnosis ? 0.5 : 1}}
                disabled={!newPatient.diagnosis}
              >
                登録
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CSVエクスポート形式選択モーダル */}
      {showExportModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '600px'}}>
            <h2 style={styles.modalTitle}>CSVエクスポート形式を選択</h2>

            <div style={{display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px'}}>
              {/* ロング形式 */}
              <div
                onClick={() => setExportFormat('long')}
                style={{
                  padding: '16px',
                  border: exportFormat === 'long' ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                  borderRadius: '12px',
                  cursor: 'pointer',
                  background: exportFormat === 'long' ? '#eff6ff' : 'white',
                  transition: 'all 0.2s'
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px'}}>
                  <input
                    type="radio"
                    checked={exportFormat === 'long'}
                    onChange={() => setExportFormat('long')}
                  />
                  <strong style={{fontSize: '15px'}}>ロング形式（統計解析向け）</strong>
                </div>
                <p style={{fontSize: '13px', color: '#6b7280', margin: '0 0 0 28px'}}>
                  1行1検査項目。R/Python/SPSSなどでの統計解析に最適。<br/>
                  検査・治療・臨床経過を別ファイルで出力。
                </p>
                <div style={{
                  marginTop: '12px',
                  marginLeft: '28px',
                  padding: '8px',
                  background: '#f8fafc',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontFamily: 'monospace'
                }}>
                  PatientID, Date, Item, Value, Unit<br/>
                  P001, 2024-01-01, WBC, 8500, /μL<br/>
                  P001, 2024-01-01, CRP, 2.5, mg/dL<br/>
                  P001, 2024-01-02, WBC, 7200, /μL
                </div>
              </div>

              {/* ワイド形式 */}
              <div
                onClick={() => setExportFormat('wide')}
                style={{
                  padding: '16px',
                  border: exportFormat === 'wide' ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                  borderRadius: '12px',
                  cursor: 'pointer',
                  background: exportFormat === 'wide' ? '#eff6ff' : 'white',
                  transition: 'all 0.2s'
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px'}}>
                  <input
                    type="radio"
                    checked={exportFormat === 'wide'}
                    onChange={() => setExportFormat('wide')}
                  />
                  <strong style={{fontSize: '15px'}}>ワイド形式（Excel閲覧向け）</strong>
                </div>
                <p style={{fontSize: '13px', color: '#6b7280', margin: '0 0 0 28px'}}>
                  1行=患者×日付、列=各検査項目。<br/>
                  Excelでそのまま閲覧・グラフ作成しやすい形式。
                </p>
                <div style={{
                  marginTop: '12px',
                  marginLeft: '28px',
                  padding: '8px',
                  background: '#f8fafc',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontFamily: 'monospace'
                }}>
                  PatientID, Date, WBC, CRP, AST, ALT<br/>
                  P001, 2024-01-01, 8500, 2.5, 25, 18<br/>
                  P001, 2024-01-02, 7200, 1.2, 22, 16<br/>
                  P002, 2024-01-01, 6800, 0.5, 30, 28
                </div>
              </div>

              {/* 統合形式 */}
              <div
                onClick={() => setExportFormat('integrated')}
                style={{
                  padding: '16px',
                  border: exportFormat === 'integrated' ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                  borderRadius: '12px',
                  cursor: 'pointer',
                  background: exportFormat === 'integrated' ? '#eff6ff' : 'white',
                  transition: 'all 0.2s'
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px'}}>
                  <input
                    type="radio"
                    checked={exportFormat === 'integrated'}
                    onChange={() => setExportFormat('integrated')}
                  />
                  <strong style={{fontSize: '15px'}}>統合タイムライン形式</strong>
                </div>
                <p style={{fontSize: '13px', color: '#6b7280', margin: '0 0 0 28px'}}>
                  検査・治療・臨床経過を1ファイルにまとめて時系列順に出力。<br/>
                  患者ごとの経過を俯瞰的に把握したい場合に最適。
                </p>
                <div style={{
                  marginTop: '12px',
                  marginLeft: '28px',
                  padding: '8px',
                  background: '#f8fafc',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontFamily: 'monospace'
                }}>
                  PatientID, Date, DataType, Category, Name, Value<br/>
                  P001, 2024-01-01, 検査, 血液, WBC, 8500<br/>
                  P001, 2024-01-01, 治療, ステロイド, mPSL, 1000<br/>
                  P001, 2024-01-02, 臨床経過, 意識障害, JCS 10,
                </div>
              </div>

              {/* Excel形式 */}
              <div
                onClick={() => setExportFormat('excel_by_sheet')}
                style={{
                  padding: '16px',
                  border: exportFormat === 'excel_by_sheet' ? '2px solid #22c55e' : '1px solid #e2e8f0',
                  borderRadius: '12px',
                  cursor: 'pointer',
                  background: exportFormat === 'excel_by_sheet' ? '#f0fdf4' : 'white',
                  transition: 'all 0.2s'
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px'}}>
                  <input
                    type="radio"
                    checked={exportFormat === 'excel_by_sheet'}
                    onChange={() => setExportFormat('excel_by_sheet')}
                  />
                  <strong style={{fontSize: '15px'}}>Excel形式（患者別シート）</strong>
                  <span style={{
                    background: '#22c55e',
                    color: 'white',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '11px'
                  }}>推奨</span>
                </div>
                <p style={{fontSize: '13px', color: '#6b7280', margin: '0 0 0 28px'}}>
                  患者ごと×検体ごとにシートを分けたExcelファイル。<br/>
                  行=検査項目、列=日付（Day1, Day3...）の臨床的な形式。
                </p>
                <div style={{
                  marginTop: '12px',
                  marginLeft: '28px',
                  padding: '8px',
                  background: '#f8fafc',
                  borderRadius: '6px',
                  fontSize: '11px'
                }}>
                  <div style={{marginBottom: '4px'}}><strong>シート構成:</strong></div>
                  <div>・患者情報（全患者一覧）</div>
                  <div>・P001_CSF, P001_Serum...（患者×検体）</div>
                  <div>・治療薬（全患者）</div>
                  <div>・臨床経過（全患者）</div>
                </div>
              </div>
            </div>

            <div style={styles.modalActions}>
              <button
                onClick={() => setShowExportModal(false)}
                style={styles.cancelButton}
              >
                キャンセル
              </button>
              <button
                onClick={() => executeExport(exportFormat)}
                disabled={isExporting}
                style={{
                  ...styles.primaryButton,
                  backgroundColor: '#28a745',
                  opacity: isExporting ? 0.7 : 1
                }}
              >
                {isExporting ? 'エクスポート中...' : 'エクスポート実行'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 患者一括インポートモーダル */}
      {showBulkImportModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '800px', maxHeight: '90vh', overflow: 'auto'}}>
            <h2 style={styles.modalTitle}>患者データ一括インポート</h2>

            <div style={{marginBottom: '20px'}}>
              <p style={{fontSize: '13px', color: '#6b7280', marginBottom: '12px'}}>
                Excel/CSVファイルから複数の患者を一括登録できます。<br/>
                以下のカラム名に対応しています：
              </p>
              <div style={{
                background: '#f8fafc',
                padding: '12px',
                borderRadius: '8px',
                fontSize: '12px',
                fontFamily: 'monospace'
              }}>
                <div><strong>PatientID / 患者ID / ID</strong> - 患者識別子（任意）</div>
                <div><strong>Diagnosis / 診断名 / 病名</strong> - 診断名（必須）</div>
                <div><strong>Group / 群</strong> - 群分け</div>
                <div><strong>OnsetDate / 発症日</strong> - 発症日 (YYYY-MM-DD)</div>
                <div><strong>Memo / メモ / 備考</strong> - メモ</div>
              </div>
            </div>

            <div style={{marginBottom: '16px'}}>
              <button
                onClick={downloadBulkImportSample}
                style={{
                  padding: '10px 16px',
                  background: '#f0fdf4',
                  color: '#047857',
                  border: '1px solid #86efac',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <span>📄</span> サンプルExcelをダウンロード
              </button>
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>ファイルを選択</label>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleBulkImportFile}
                style={{...styles.input, padding: '10px'}}
              />
            </div>

            {bulkImportData.length > 0 && (
              <div style={{marginTop: '20px'}}>
                <p style={{fontWeight: '500', marginBottom: '12px'}}>
                  プレビュー（{bulkImportData.length}件）
                </p>
                <div style={{maxHeight: '300px', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px'}}>
                  <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '12px'}}>
                    <thead>
                      <tr style={{background: '#f1f5f9', position: 'sticky', top: 0}}>
                        <th style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>ID</th>
                        <th style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>診断名</th>
                        <th style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>群</th>
                        <th style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>発症日</th>
                        <th style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>メモ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkImportData.map((row, idx) => (
                        <tr key={idx} style={{background: idx % 2 === 0 ? 'white' : '#f8fafc'}}>
                          <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0'}}>{row.patientId}</td>
                          <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', color: row.diagnosis ? 'inherit' : '#ef4444'}}>
                            {row.diagnosis || '（必須）'}
                          </td>
                          <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0'}}>{row.group}</td>
                          <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0'}}>{row.onsetDate}</td>
                          <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                            {row.memo}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div style={styles.modalActions}>
              <button
                onClick={() => {
                  setShowBulkImportModal(false);
                  setBulkImportData([]);
                }}
                style={styles.cancelButton}
              >
                キャンセル
              </button>
              <button
                onClick={executeBulkImport}
                disabled={bulkImportData.length === 0 || isBulkImporting}
                style={{
                  ...styles.primaryButton,
                  backgroundColor: '#f59e0b',
                  opacity: bulkImportData.length === 0 ? 0.5 : 1
                }}
              >
                {isBulkImporting ? 'インポート中...' : `${bulkImportData.length}件をインポート`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 検査・臨床経過一括インポートモーダル */}
      {showBulkLabImportModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '900px', maxHeight: '90vh', overflow: 'auto'}}>
            <h2 style={styles.modalTitle}>検査・臨床経過 一括インポート</h2>

            <div style={{marginBottom: '20px'}}>
              <p style={{fontSize: '13px', color: '#6b7280', marginBottom: '12px'}}>
                Excelファイルから複数患者のデータを一括登録できます。
              </p>
              <div style={{
                background: '#f8fafc',
                padding: '12px',
                borderRadius: '8px',
                fontSize: '12px'
              }}>
                <div><strong>対応形式:</strong></div>
                <div>・各シート = 1患者（シート名またはセル内の患者IDで照合）</div>
                <div>・検査データ:「検査項目」「単位」列 + 日付列</div>
                <div>・臨床経過:「発作頻度推移」等のシート（患者ID列 + 時点列）</div>
              </div>
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Excelファイルを選択</label>
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={handleBulkLabImportFile}
                style={{...styles.input, padding: '10px'}}
              />
            </div>

            {bulkLabImportData.length > 0 && (
              <div style={{marginTop: '20px'}}>
                <p style={{fontWeight: '500', marginBottom: '12px', color: '#1e40af'}}>
                  🔬 検査データ（{bulkLabImportData.length}シート）
                </p>
                <div style={{maxHeight: '250px', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px'}}>
                  <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '12px'}}>
                    <thead>
                      <tr style={{background: '#f1f5f9', position: 'sticky', top: 0}}>
                        <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>シート名</th>
                        <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>患者ID</th>
                        <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>対象患者</th>
                        <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>日数</th>
                        <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>項目数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkLabImportData.map((row, idx) => (
                        <tr key={idx} style={{background: idx % 2 === 0 ? 'white' : '#f8fafc'}}>
                          <td style={{padding: '10px', borderBottom: '1px solid #e2e8f0'}}>{row.sheetName}</td>
                          <td style={{padding: '10px', borderBottom: '1px solid #e2e8f0'}}>{row.patientId}</td>
                          <td style={{padding: '10px', borderBottom: '1px solid #e2e8f0'}}>
                            <select
                              value={row.matchedPatient?.id || ''}
                              onChange={(e) => {
                                const selectedPatient = patients.find(p => p.id === e.target.value);
                                setBulkLabImportData(prev => prev.map((item, i) =>
                                  i === idx ? {...item, matchedPatient: selectedPatient} : item
                                ));
                              }}
                              style={{
                                padding: '6px 10px',
                                borderRadius: '6px',
                                border: row.matchedPatient ? '1px solid #10b981' : '1px solid #f87171',
                                background: row.matchedPatient ? '#f0fdf4' : '#fef2f2',
                                fontSize: '12px',
                                minWidth: '150px'
                              }}
                            >
                              <option value="">-- 患者を選択 --</option>
                              {patients.map(p => (
                                <option key={p.id} value={p.id}>
                                  {p.displayId} - {p.diagnosis}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>
                            {row.labData.length}日分
                          </td>
                          <td style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>
                            {row.totalItems}項目
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {bulkClinicalEventData.length > 0 && (
              <div style={{marginTop: '20px'}}>
                <p style={{fontWeight: '500', marginBottom: '12px', color: '#7c3aed'}}>
                  📋 臨床経過データ（{bulkClinicalEventData.length}患者）
                </p>
                <div style={{maxHeight: '200px', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px'}}>
                  <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '12px'}}>
                    <thead>
                      <tr style={{background: '#f5f3ff', position: 'sticky', top: 0}}>
                        <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>患者ID</th>
                        <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>対象患者</th>
                        <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>イベント種類</th>
                        <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>データ数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkClinicalEventData.map((row, idx) => (
                        <tr key={idx} style={{background: idx % 2 === 0 ? 'white' : '#faf5ff'}}>
                          <td style={{padding: '10px', borderBottom: '1px solid #e2e8f0'}}>{row.patientId}</td>
                          <td style={{padding: '10px', borderBottom: '1px solid #e2e8f0'}}>
                            <select
                              value={row.matchedPatient?.id || ''}
                              onChange={(e) => {
                                const selectedPatient = patients.find(p => p.id === e.target.value);
                                setBulkClinicalEventData(prev => prev.map((item, i) =>
                                  i === idx ? {...item, matchedPatient: selectedPatient} : item
                                ));
                              }}
                              style={{
                                padding: '6px 10px',
                                borderRadius: '6px',
                                border: row.matchedPatient ? '1px solid #10b981' : '1px solid #f87171',
                                background: row.matchedPatient ? '#f0fdf4' : '#fef2f2',
                                fontSize: '12px',
                                minWidth: '150px'
                              }}
                            >
                              <option value="">-- 患者を選択 --</option>
                              {patients.map(p => (
                                <option key={p.id} value={p.id}>
                                  {p.displayId} - {p.diagnosis}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={{padding: '10px', borderBottom: '1px solid #e2e8f0'}}>{row.eventType}</td>
                          <td style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>
                            {row.events.length}件
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(bulkLabImportData.length > 0 || bulkClinicalEventData.length > 0) && (
              <p style={{fontSize: '12px', color: '#6b7280', marginTop: '12px'}}>
                ✓マークの患者のみインポートされます。患者が見つからない場合は、先に患者を登録してください。
              </p>
            )}

            <div style={styles.modalActions}>
              <button
                onClick={() => {
                  setShowBulkLabImportModal(false);
                  setBulkLabImportData([]);
                  setBulkClinicalEventData([]);
                }}
                style={styles.cancelButton}
              >
                キャンセル
              </button>
              <button
                onClick={executeBulkLabImport}
                disabled={(bulkLabImportData.filter(d => d.matchedPatient).length === 0 && bulkClinicalEventData.filter(d => d.matchedPatient).length === 0) || isBulkLabImporting}
                style={{
                  ...styles.primaryButton,
                  backgroundColor: '#8b5cf6',
                  opacity: (bulkLabImportData.filter(d => d.matchedPatient).length === 0 && bulkClinicalEventData.filter(d => d.matchedPatient).length === 0) ? 0.5 : 1
                }}
              >
                {isBulkLabImporting ? 'インポート中...' : `インポート実行`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 経時データ分析モーダル */}
      {showAnalysisModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '900px', maxHeight: '90vh', overflow: 'auto'}}>
            <h2 style={styles.modalTitle}>経時データ分析</h2>

            {isLoadingAnalysis && !analysisData ? (
              <div style={{textAlign: 'center', padding: '40px'}}>
                データを読み込み中...
              </div>
            ) : (
              <>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px'}}>
                  {/* 患者選択 */}
                  <div>
                    <label style={styles.inputLabel}>患者を選択</label>
                    <div style={{display: 'flex', gap: '8px', marginBottom: '8px'}}>
                      <button
                        onClick={() => setSelectedPatientIds(patients.map(p => p.id))}
                        style={{
                          padding: '4px 10px',
                          fontSize: '11px',
                          background: '#3b82f6',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        全て選択
                      </button>
                      <button
                        onClick={() => setSelectedPatientIds([])}
                        style={{
                          padding: '4px 10px',
                          fontSize: '11px',
                          background: '#6b7280',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        全て解除
                      </button>
                    </div>
                    <div style={{
                      maxHeight: '200px',
                      overflow: 'auto',
                      border: '1px solid #e2e8f0',
                      borderRadius: '8px',
                      padding: '8px'
                    }}>
                      {patients.map(patient => (
                        <label
                          key={patient.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px',
                            cursor: 'pointer',
                            borderRadius: '4px',
                            background: selectedPatientIds.includes(patient.id) ? '#eff6ff' : 'transparent'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selectedPatientIds.includes(patient.id)}
                            onChange={() => togglePatientSelection(patient.id)}
                          />
                          <span style={{fontWeight: '500'}}>{patient.displayId}</span>
                          <span style={{fontSize: '12px', color: '#6b7280'}}>
                            {patient.diagnosis}
                            {patient.group && ` (${patient.group})`}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div style={{marginTop: '8px', fontSize: '12px', color: '#6b7280'}}>
                      {selectedPatientIds.length}人選択中
                    </div>
                  </div>

                  {/* 項目選択 */}
                  <div>
                    <label style={styles.inputLabel}>検査項目を選択</label>
                    <div style={{display: 'flex', gap: '8px', marginBottom: '8px'}}>
                      <button
                        onClick={() => setSelectedItems([...availableItems])}
                        disabled={availableItems.length === 0}
                        style={{
                          padding: '4px 10px',
                          fontSize: '11px',
                          background: availableItems.length === 0 ? '#d1d5db' : '#10b981',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: availableItems.length === 0 ? 'not-allowed' : 'pointer'
                        }}
                      >
                        全て選択
                      </button>
                      <button
                        onClick={() => setSelectedItems([])}
                        style={{
                          padding: '4px 10px',
                          fontSize: '11px',
                          background: '#6b7280',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        全て解除
                      </button>
                    </div>
                    <div style={{
                      maxHeight: '200px',
                      overflow: 'auto',
                      border: '1px solid #e2e8f0',
                      borderRadius: '8px',
                      padding: '8px'
                    }}>
                      {availableItems.length === 0 ? (
                        <div style={{padding: '16px', textAlign: 'center', color: '#6b7280'}}>
                          検査データがありません
                        </div>
                      ) : (
                        availableItems.map(item => (
                          <label
                            key={item}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              padding: '6px 8px',
                              cursor: 'pointer',
                              borderRadius: '4px',
                              background: selectedItems.includes(item) ? '#f0fdf4' : 'transparent'
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedItems.includes(item)}
                              onChange={() => toggleItemSelection(item)}
                            />
                            <span>{item}</span>
                          </label>
                        ))
                      )}
                    </div>
                    <div style={{marginTop: '8px', fontSize: '12px', color: '#6b7280'}}>
                      {selectedItems.length}項目選択中
                    </div>
                  </div>
                </div>

                <button
                  onClick={generateAnalysisData}
                  disabled={selectedPatientIds.length === 0 || selectedItems.length === 0 || isLoadingAnalysis}
                  style={{
                    ...styles.primaryButton,
                    width: '100%',
                    marginBottom: '20px',
                    opacity: (selectedPatientIds.length === 0 || selectedItems.length === 0) ? 0.5 : 1
                  }}
                >
                  {isLoadingAnalysis ? 'グラフ生成中...' : 'グラフを生成'}
                </button>

                {/* グラフ表示（検査項目ごとに別々のグラフ） */}
                {analysisData && Array.isArray(analysisData) && analysisData.length > 0 && (
                  <div>
                    {analysisData.map((chartData, chartIndex) => (
                      <div key={chartIndex} style={{
                        background: '#f8fafc',
                        padding: '20px',
                        borderRadius: '12px',
                        marginBottom: '20px'
                      }}>
                        <Line
                          ref={chartIndex === 0 ? chartRef : null}
                          data={{
                            labels: chartData.labels,
                            datasets: chartData.datasets
                          }}
                          options={{
                            responsive: true,
                            plugins: {
                              legend: {
                                position: 'top',
                              },
                              title: {
                                display: true,
                                text: `${chartData.itemName}${chartData.unit ? ` (${chartData.unit})` : ''}`
                              },
                              tooltip: {
                                callbacks: {
                                  label: function(context) {
                                    return `${context.dataset.label}: ${context.parsed.y}${chartData.unit ? ' ' + chartData.unit : ''}`;
                                  }
                                }
                              }
                            },
                            scales: {
                              x: {
                                type: 'linear',
                                title: {
                                  display: true,
                                  text: '発症からの日数'
                                }
                              },
                              y: {
                                title: {
                                  display: true,
                                  text: chartData.unit || '値'
                                }
                              }
                            }
                          }}
                        />
                      </div>
                    ))}
                    {/* エクスポートボタン */}
                    <div style={{
                      display: 'flex',
                      gap: '10px',
                      marginTop: '16px',
                      justifyContent: 'center'
                    }}>
                      <button
                        onClick={exportAnalysisCSV}
                        style={{
                          ...styles.addButton,
                          backgroundColor: '#28a745',
                          padding: '8px 16px',
                          fontSize: '14px'
                        }}
                      >
                        📊 CSVダウンロード
                      </button>
                      <button
                        onClick={exportChartImage}
                        style={{
                          ...styles.addButton,
                          backgroundColor: '#0ea5e9',
                          padding: '8px 16px',
                          fontSize: '14px'
                        }}
                      >
                        🖼️ グラフ画像ダウンロード
                      </button>
                    </div>
                  </div>
                )}

                {analysisData && Array.isArray(analysisData) && analysisData.length === 0 && (
                  <div style={{
                    textAlign: 'center',
                    padding: '40px',
                    background: '#fef3c7',
                    borderRadius: '12px',
                    color: '#92400e'
                  }}>
                    選択した条件に一致するデータがありません。
                    <br />
                    発症日が設定されている患者と、検査データがある項目を選択してください。
                  </div>
                )}

                {/* 群間比較セクション */}
                <div style={{
                  marginTop: '30px',
                  padding: '20px',
                  background: '#faf5ff',
                  borderRadius: '12px',
                  border: '1px solid #e9d5ff'
                }}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px'}}>
                    <h3 style={{margin: 0, color: '#7c3aed', fontSize: '16px'}}>📊 群間統計比較</h3>
                    <button
                      onClick={() => setShowGroupComparison(!showGroupComparison)}
                      style={{
                        background: showGroupComparison ? '#7c3aed' : 'white',
                        color: showGroupComparison ? 'white' : '#7c3aed',
                        border: '1px solid #7c3aed',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px'
                      }}
                    >
                      {showGroupComparison ? '閉じる' : '開く'}
                    </button>
                  </div>

                  {showGroupComparison && (
                    <>
                      {availableGroups.length < 2 ? (
                        <div style={{padding: '20px', textAlign: 'center', color: '#6b7280'}}>
                          群間比較には2つ以上の群が必要です。<br/>
                          患者登録時に「群」を設定してください。
                        </div>
                      ) : (
                        <>
                          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px'}}>
                            <div>
                              <label style={styles.inputLabel}>群1</label>
                              <select
                                value={selectedGroup1}
                                onChange={(e) => setSelectedGroup1(e.target.value)}
                                style={{...styles.input, width: '100%'}}
                              >
                                <option value="">選択してください</option>
                                {availableGroups.map(g => (
                                  <option key={g} value={g} disabled={g === selectedGroup2}>{g}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label style={styles.inputLabel}>群2</label>
                              <select
                                value={selectedGroup2}
                                onChange={(e) => setSelectedGroup2(e.target.value)}
                                style={{...styles.input, width: '100%'}}
                              >
                                <option value="">選択してください</option>
                                {availableGroups.map(g => (
                                  <option key={g} value={g} disabled={g === selectedGroup1}>{g}</option>
                                ))}
                              </select>
                            </div>
                          </div>

                          {/* 発症日からの日数範囲指定 */}
                          <div style={{
                            padding: '12px',
                            background: '#f0f9ff',
                            borderRadius: '8px',
                            marginBottom: '16px',
                            border: '1px solid #bae6fd'
                          }}>
                            <label style={{...styles.inputLabel, marginBottom: '8px', display: 'block'}}>
                              📅 発症からの日数で絞り込み（任意）
                            </label>
                            <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                              <span style={{fontSize: '13px', color: '#475569'}}>Day</span>
                              <input
                                type="number"
                                value={dayRangeStart}
                                onChange={(e) => setDayRangeStart(e.target.value)}
                                style={{...styles.input, width: '80px', padding: '6px 10px'}}
                                placeholder="開始"
                              />
                              <span style={{fontSize: '13px', color: '#475569'}}>〜</span>
                              <input
                                type="number"
                                value={dayRangeEnd}
                                onChange={(e) => setDayRangeEnd(e.target.value)}
                                style={{...styles.input, width: '80px', padding: '6px 10px'}}
                                placeholder="終了"
                              />
                              <span style={{fontSize: '12px', color: '#6b7280'}}>日目</span>
                              {(dayRangeStart !== '' || dayRangeEnd !== '') && (
                                <button
                                  onClick={() => { setDayRangeStart(''); setDayRangeEnd(''); }}
                                  style={{
                                    background: '#e2e8f0',
                                    border: 'none',
                                    borderRadius: '4px',
                                    padding: '4px 8px',
                                    fontSize: '11px',
                                    cursor: 'pointer',
                                    color: '#475569'
                                  }}
                                >
                                  クリア
                                </button>
                              )}
                            </div>
                            <p style={{fontSize: '11px', color: '#64748b', marginTop: '6px', marginBottom: 0}}>
                              例: Day 0〜3 で急性期、Day 7〜14 で亜急性期のデータのみを比較
                            </p>
                          </div>

                          <p style={{fontSize: '12px', color: '#6b7280', marginBottom: '12px'}}>
                            ※ 上で選択した検査項目について、2群間の統計比較を行います
                            {(dayRangeStart !== '' || dayRangeEnd !== '') && (
                              <span style={{color: '#7c3aed', fontWeight: '500'}}>
                                （Day {dayRangeStart || '?'} 〜 {dayRangeEnd || '?'} のみ）
                              </span>
                            )}
                          </p>

                          <button
                            onClick={runGroupComparison}
                            disabled={!selectedGroup1 || !selectedGroup2 || selectedItems.length === 0 || isLoadingAnalysis}
                            style={{
                              ...styles.primaryButton,
                              width: '100%',
                              backgroundColor: '#7c3aed',
                              opacity: (!selectedGroup1 || !selectedGroup2 || selectedItems.length === 0) ? 0.5 : 1
                            }}
                          >
                            {isLoadingAnalysis ? '計算中...' : '統計比較を実行'}
                          </button>

                          {/* 統計結果表示 */}
                          {comparisonResults && comparisonResults.length > 0 && (
                            <div style={{marginTop: '20px'}}>
                              <div style={{overflowX: 'auto'}}>
                                <table style={{
                                  width: '100%',
                                  borderCollapse: 'collapse',
                                  fontSize: '12px',
                                  background: 'white',
                                  borderRadius: '8px',
                                  overflow: 'hidden'
                                }}>
                                  <thead>
                                    <tr style={{background: '#f1f5f9'}}>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>項目</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}} colSpan="3">{selectedGroup1}</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}} colSpan="3">{selectedGroup2}</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>t検定 p値</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>U検定 p値</th>
                                    </tr>
                                    <tr style={{background: '#f8fafc', fontSize: '11px'}}>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}></th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>n</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>Mean±SD</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>Median</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>n</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>Mean±SD</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>Median</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}></th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {comparisonResults.map((r, idx) => (
                                      <tr key={idx} style={{background: idx % 2 === 0 ? 'white' : '#f8fafc'}}>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', fontWeight: '500'}}>{r.item}</td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>{r.group1.n}</td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>{r.group1.mean}±{r.group1.std}</td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>{r.group1.median}</td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>{r.group2.n}</td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>{r.group2.mean}±{r.group2.std}</td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>{r.group2.median}</td>
                                        <td style={{
                                          padding: '8px',
                                          borderBottom: '1px solid #e2e8f0',
                                          textAlign: 'center',
                                          fontWeight: r.tTest.significant ? 'bold' : 'normal',
                                          color: r.tTest.significant ? '#dc2626' : 'inherit'
                                        }}>
                                          {r.tTest.p || '-'}{r.tTest.significant && ' *'}
                                        </td>
                                        <td style={{
                                          padding: '8px',
                                          borderBottom: '1px solid #e2e8f0',
                                          textAlign: 'center',
                                          fontWeight: r.mannWhitney.significant ? 'bold' : 'normal',
                                          color: r.mannWhitney.significant ? '#dc2626' : 'inherit'
                                        }}>
                                          {r.mannWhitney.p || '-'}{r.mannWhitney.significant && ' *'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <p style={{fontSize: '11px', color: '#6b7280', marginTop: '8px'}}>
                                * p &lt; 0.05（統計的に有意）　t検定: Welchのt検定（パラメトリック）　U検定: Mann-Whitney U検定（ノンパラメトリック）
                              </p>
                              <button
                                onClick={exportComparisonCSV}
                                style={{
                                  ...styles.addButton,
                                  backgroundColor: '#28a745',
                                  padding: '8px 16px',
                                  fontSize: '13px',
                                  marginTop: '12px'
                                }}
                              >
                                📊 統計結果CSVダウンロード
                              </button>

                              {/* 統計グラフ（Box Plot / Violin Plot） */}
                              <div style={{
                                marginTop: '24px',
                                padding: '16px',
                                background: '#f8fafc',
                                borderRadius: '8px',
                                border: '1px solid #e2e8f0'
                              }}>
                                <h4 style={{margin: '0 0 12px 0', fontSize: '14px', color: '#374151'}}>
                                  📈 論文用グラフ作成
                                </h4>

                                <div style={{display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center'}}>
                                  <label style={{fontSize: '13px', color: '#374151'}}>グラフ種類:</label>
                                  {['boxplot', 'violin', 'bar'].map(type => (
                                    <label key={type} style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                      padding: '6px 12px',
                                      background: statChartType === type ? '#7c3aed' : 'white',
                                      color: statChartType === type ? 'white' : '#374151',
                                      borderRadius: '6px',
                                      cursor: 'pointer',
                                      border: '1px solid #d1d5db',
                                      fontSize: '12px'
                                    }}>
                                      <input
                                        type="radio"
                                        name="chartType"
                                        value={type}
                                        checked={statChartType === type}
                                        onChange={() => setStatChartType(type)}
                                        style={{display: 'none'}}
                                      />
                                      {type === 'boxplot' && 'Box Plot'}
                                      {type === 'violin' && 'Violin Plot'}
                                      {type === 'bar' && 'Bar (Mean±SD)'}
                                    </label>
                                  ))}
                                </div>

                                <div style={{display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center'}}>
                                  <label style={{fontSize: '13px', color: '#374151'}}>個別データ点:</label>
                                  {[
                                    { value: 'black', label: '黒丸 ●' },
                                    { value: 'white', label: '白丸 ○' },
                                    { value: 'none', label: '非表示' }
                                  ].map(opt => (
                                    <label key={opt.value} style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                      padding: '6px 12px',
                                      background: showDataPoints === opt.value ? '#059669' : 'white',
                                      color: showDataPoints === opt.value ? 'white' : '#374151',
                                      borderRadius: '6px',
                                      cursor: 'pointer',
                                      border: '1px solid #d1d5db',
                                      fontSize: '12px'
                                    }}>
                                      <input
                                        type="radio"
                                        name="dataPoints"
                                        value={opt.value}
                                        checked={showDataPoints === opt.value}
                                        onChange={() => setShowDataPoints(opt.value)}
                                        style={{display: 'none'}}
                                      />
                                      {opt.label}
                                    </label>
                                  ))}
                                </div>

                                <div style={{marginBottom: '16px'}}>
                                  <label style={{fontSize: '13px', color: '#374151', display: 'block', marginBottom: '6px'}}>
                                    表示する項目（複数選択可）:
                                  </label>
                                  <div style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: '8px',
                                    padding: '12px',
                                    background: '#f9fafb',
                                    borderRadius: '8px',
                                    border: '1px solid #e5e7eb',
                                    maxHeight: '120px',
                                    overflowY: 'auto'
                                  }}>
                                    {selectedItems.map(item => (
                                      <label key={item} style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '4px',
                                        padding: '4px 10px',
                                        background: statSelectedItems.includes(item) ? '#dbeafe' : 'white',
                                        border: statSelectedItems.includes(item) ? '2px solid #3b82f6' : '1px solid #d1d5db',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '12px',
                                        transition: 'all 0.15s'
                                      }}>
                                        <input
                                          type="checkbox"
                                          checked={statSelectedItems.includes(item)}
                                          onChange={(e) => {
                                            if (e.target.checked) {
                                              setStatSelectedItems([...statSelectedItems, item]);
                                            } else {
                                              setStatSelectedItems(statSelectedItems.filter(i => i !== item));
                                            }
                                          }}
                                          style={{display: 'none'}}
                                        />
                                        {statSelectedItems.includes(item) && <span style={{color: '#3b82f6'}}>✓</span>}
                                        {item}
                                      </label>
                                    ))}
                                  </div>
                                  <div style={{marginTop: '6px', display: 'flex', gap: '8px'}}>
                                    <button
                                      onClick={() => setStatSelectedItems([...selectedItems])}
                                      style={{fontSize: '11px', padding: '4px 8px', background: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                                    >
                                      全選択
                                    </button>
                                    <button
                                      onClick={() => setStatSelectedItems([])}
                                      style={{fontSize: '11px', padding: '4px 8px', background: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                                    >
                                      全解除
                                    </button>
                                    <span style={{fontSize: '11px', color: '#6b7280', marginLeft: '8px'}}>
                                      {statSelectedItems.length}項目選択中
                                    </span>
                                  </div>
                                </div>

                                {statSelectedItems.length > 0 && comparisonResults && (() => {
                                  // グラフ描画関数
                                  const renderChart = (itemName, chartIndex) => {
                                    const result = comparisonResults.find(r => r.item === itemName);
                                    if (!result) return null;

                                    const stats1 = calculateStats(result.group1.values);
                                    const stats2 = calculateStats(result.group2.values);
                                    if (!stats1 || !stats2) return <div key={chartIndex} style={{padding: '20px', color: '#6b7280'}}>データ不足: {itemName}</div>;

                                    // 正規性検定
                                    const norm1 = shapiroWilkTest(result.group1.values);
                                    const norm2 = shapiroWilkTest(result.group2.values);
                                    const bothNormal = norm1.isNormal && norm2.isNormal;

                                    // 適切な検定を選択
                                    const testResult = bothNormal
                                      ? tTest(result.group1.values, result.group2.values)
                                      : mannWhitneyU(result.group1.values, result.group2.values);
                                    const pValue = testResult.pValue;
                                    const sigMarker = getSignificanceMarker(pValue);

                                    // SVGでグラフを描画（複数表示用にコンパクトに）
                                    const svgWidth = statSelectedItems.length === 1 ? 500 : 350;
                                    const svgHeight = statSelectedItems.length === 1 ? 350 : 280;
                                  const margin = { top: 40, right: 30, bottom: 60, left: 60 };
                                  const chartWidth = svgWidth - margin.left - margin.right;
                                  const chartHeight = svgHeight - margin.top - margin.bottom;

                                  const allValues = [...result.group1.values, ...result.group2.values];
                                  const minVal = Math.min(...allValues);
                                  const maxVal = Math.max(...allValues);
                                  const range = maxVal - minVal || 1;
                                  const yMin = minVal - range * 0.1;
                                  const yMax = maxVal + range * 0.15;
                                  const yScale = (v) => margin.top + chartHeight - ((v - yMin) / (yMax - yMin)) * chartHeight;

                                  const boxWidth = 60;
                                  const x1 = margin.left + chartWidth * 0.25;
                                  const x2 = margin.left + chartWidth * 0.75;

                                  // Y軸の目盛り
                                  const yTicks = [];
                                  const tickStep = (yMax - yMin) / 5;
                                  for (let i = 0; i <= 5; i++) {
                                    yTicks.push(yMin + tickStep * i);
                                  }

                                  let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="font-family: Arial, sans-serif;">`;
                                  svgContent += `<rect width="100%" height="100%" fill="white"/>`;

                                  // タイトル
                                    svgContent += `<text x="${svgWidth/2}" y="20" text-anchor="middle" font-size="14" font-weight="bold">${itemName}</text>`;

                                  // 有意差表示
                                  if (pValue < 0.05) {
                                    const bracketY = yScale(maxVal) - 15;
                                    svgContent += `<line x1="${x1}" y1="${bracketY}" x2="${x1}" y2="${bracketY + 5}" stroke="#333" stroke-width="1"/>`;
                                    svgContent += `<line x1="${x1}" y1="${bracketY}" x2="${x2}" y2="${bracketY}" stroke="#333" stroke-width="1"/>`;
                                    svgContent += `<line x1="${x2}" y1="${bracketY}" x2="${x2}" y2="${bracketY + 5}" stroke="#333" stroke-width="1"/>`;
                                    svgContent += `<text x="${(x1+x2)/2}" y="${bracketY - 5}" text-anchor="middle" font-size="14" font-weight="bold">${sigMarker}</text>`;
                                  }

                                  // Y軸
                                  svgContent += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#333" stroke-width="1"/>`;
                                  yTicks.forEach(tick => {
                                    const y = yScale(tick);
                                    svgContent += `<line x1="${margin.left - 5}" y1="${y}" x2="${margin.left}" y2="${y}" stroke="#333" stroke-width="1"/>`;
                                    svgContent += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-size="10">${tick.toFixed(1)}</text>`;
                                    svgContent += `<line x1="${margin.left}" y1="${y}" x2="${svgWidth - margin.right}" y2="${y}" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="3,3"/>`;
                                  });

                                  // X軸
                                  svgContent += `<line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${svgWidth - margin.right}" y2="${margin.top + chartHeight}" stroke="#333" stroke-width="1"/>`;

                                  // グループ名
                                  svgContent += `<text x="${x1}" y="${svgHeight - 25}" text-anchor="middle" font-size="12">${selectedGroup1}</text>`;
                                  svgContent += `<text x="${x1}" y="${svgHeight - 10}" text-anchor="middle" font-size="10" fill="#666">(n=${stats1.n})</text>`;
                                  svgContent += `<text x="${x2}" y="${svgHeight - 25}" text-anchor="middle" font-size="12">${selectedGroup2}</text>`;
                                  svgContent += `<text x="${x2}" y="${svgHeight - 10}" text-anchor="middle" font-size="10" fill="#666">(n=${stats2.n})</text>`;

                                  // Box Plot描画
                                  const drawBox = (stats, x, color) => {
                                    const yQ1 = yScale(stats.q1);
                                    const yQ3 = yScale(stats.q3);
                                    const yMed = yScale(stats.median);
                                    const yWhiskerLow = yScale(stats.whiskerLow);
                                    const yWhiskerHigh = yScale(stats.whiskerHigh);

                                    if (statChartType === 'boxplot') {
                                      // ボックス
                                      svgContent += `<rect x="${x - boxWidth/2}" y="${yQ3}" width="${boxWidth}" height="${yQ1 - yQ3}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="2"/>`;
                                      // 中央線
                                      svgContent += `<line x1="${x - boxWidth/2}" y1="${yMed}" x2="${x + boxWidth/2}" y2="${yMed}" stroke="${color}" stroke-width="3"/>`;
                                      // ヒゲ
                                      svgContent += `<line x1="${x}" y1="${yQ1}" x2="${x}" y2="${yWhiskerLow}" stroke="${color}" stroke-width="1.5"/>`;
                                      svgContent += `<line x1="${x}" y1="${yQ3}" x2="${x}" y2="${yWhiskerHigh}" stroke="${color}" stroke-width="1.5"/>`;
                                      svgContent += `<line x1="${x - boxWidth/4}" y1="${yWhiskerLow}" x2="${x + boxWidth/4}" y2="${yWhiskerLow}" stroke="${color}" stroke-width="1.5"/>`;
                                      svgContent += `<line x1="${x - boxWidth/4}" y1="${yWhiskerHigh}" x2="${x + boxWidth/4}" y2="${yWhiskerHigh}" stroke="${color}" stroke-width="1.5"/>`;

                                      // 個別データ点（オプションに応じて表示）
                                      if (showDataPoints !== 'none') {
                                        stats.values.forEach((v, i) => {
                                          const jitter = (Math.random() - 0.5) * boxWidth * 0.6;
                                          if (showDataPoints === 'black') {
                                            svgContent += `<circle cx="${x + jitter}" cy="${yScale(v)}" r="3" fill="#333" fill-opacity="0.7"/>`;
                                          } else {
                                            svgContent += `<circle cx="${x + jitter}" cy="${yScale(v)}" r="3" fill="white" stroke="#333" stroke-width="1"/>`;
                                          }
                                        });
                                      }

                                      // 外れ値
                                      stats.outliers.forEach(v => {
                                        svgContent += `<circle cx="${x}" cy="${yScale(v)}" r="4" fill="none" stroke="${color}" stroke-width="1.5"/>`;
                                      });
                                    } else if (statChartType === 'violin') {
                                      // Violin: R (ggplot2) 風のカーネル密度推定
                                      // Silverman's rule of thumb for bandwidth
                                      const bandwidth = 0.9 * Math.min(stats.sd, stats.iqr / 1.34) * Math.pow(stats.n, -0.2) || (stats.sd * 0.5);

                                      // データ範囲を少し拡張（端を滑らかに）
                                      const dataRange = stats.max - stats.min;
                                      const extendedMin = stats.min - dataRange * 0.1;
                                      const extendedMax = stats.max + dataRange * 0.1;

                                      const density = [];
                                      const steps = 60; // より滑らかな曲線
                                      for (let i = 0; i <= steps; i++) {
                                        const y = extendedMin + (extendedMax - extendedMin) * (i / steps);
                                        let d = 0;
                                        stats.values.forEach(v => {
                                          // ガウシアンカーネル
                                          d += Math.exp(-0.5 * Math.pow((y - v) / bandwidth, 2));
                                        });
                                        d /= stats.n * bandwidth * Math.sqrt(2 * Math.PI);
                                        density.push({ y, d });
                                      }
                                      const maxDensity = Math.max(...density.map(p => p.d));
                                      const violinWidth = boxWidth * 1.0;

                                      // Violin path（滑らかな曲線）
                                      let leftPoints = [];
                                      let rightPoints = [];
                                      density.forEach(p => {
                                        const w = (p.d / maxDensity) * (violinWidth / 2);
                                        const yPos = yScale(p.y);
                                        leftPoints.push(`${x - w},${yPos}`);
                                        rightPoints.unshift(`${x + w},${yPos}`);
                                      });

                                      // SVG path with smooth curve
                                      const allPoints = [...leftPoints, ...rightPoints];
                                      svgContent += `<polygon points="${allPoints.join(' ')}" fill="${color}" fill-opacity="0.4" stroke="${color}" stroke-width="1"/>`;

                                      // 個別データ点（ggplot2 geom_jitter風、violinの内側に表示）
                                      if (showDataPoints !== 'none') {
                                        stats.values.forEach((v, i) => {
                                          // violin幅に応じたjitter（データ点がviolin内に収まるように）
                                          const yVal = v;
                                          const nearestDensity = density.reduce((prev, curr) =>
                                            Math.abs(curr.y - yVal) < Math.abs(prev.y - yVal) ? curr : prev
                                          );
                                          const maxJitter = (nearestDensity.d / maxDensity) * (violinWidth / 2) * 0.8;
                                          const jitter = (Math.random() - 0.5) * 2 * maxJitter;
                                          if (showDataPoints === 'black') {
                                            svgContent += `<circle cx="${x + jitter}" cy="${yScale(v)}" r="2.5" fill="#333" fill-opacity="0.8"/>`;
                                          } else {
                                            svgContent += `<circle cx="${x + jitter}" cy="${yScale(v)}" r="2.5" fill="white" stroke="#333" stroke-width="0.8"/>`;
                                          }
                                        });
                                      }

                                      // 内部のボックスプロット（ggplot2スタイル）
                                      const thinLineWidth = 1;
                                      // ヒゲ（細い線）
                                      svgContent += `<line x1="${x}" y1="${yWhiskerLow}" x2="${x}" y2="${yWhiskerHigh}" stroke="black" stroke-width="${thinLineWidth}"/>`;

                                      // IQRボックス（黒い細い四角）
                                      const innerBoxWidth = 8;
                                      svgContent += `<rect x="${x - innerBoxWidth/2}" y="${yQ3}" width="${innerBoxWidth}" height="${yQ1 - yQ3}" fill="black" stroke="none"/>`;

                                      // 中央値（白い点）
                                      svgContent += `<circle cx="${x}" cy="${yMed}" r="3" fill="white" stroke="none"/>`;
                                    } else if (statChartType === 'bar') {
                                      // Bar chart with error bars
                                      const yMean = yScale(stats.mean);
                                      const yBase = yScale(yMin);
                                      const barW = boxWidth * 0.7;

                                      svgContent += `<rect x="${x - barW/2}" y="${yMean}" width="${barW}" height="${yBase - yMean}" fill="${color}" fill-opacity="0.7"/>`;

                                      // エラーバー (Mean ± SD)
                                      const yTop = yScale(stats.mean + stats.sd);
                                      const yBottom = yScale(Math.max(stats.mean - stats.sd, yMin));
                                      svgContent += `<line x1="${x}" y1="${yTop}" x2="${x}" y2="${yBottom}" stroke="#333" stroke-width="1.5"/>`;
                                      svgContent += `<line x1="${x - 8}" y1="${yTop}" x2="${x + 8}" y2="${yTop}" stroke="#333" stroke-width="1.5"/>`;
                                      svgContent += `<line x1="${x - 8}" y1="${yBottom}" x2="${x + 8}" y2="${yBottom}" stroke="#333" stroke-width="1.5"/>`;

                                      // 個別データ点（オプションに応じて表示）
                                      if (showDataPoints !== 'none') {
                                        stats.values.forEach((v, i) => {
                                          const jitter = (Math.random() - 0.5) * barW * 0.8;
                                          if (showDataPoints === 'black') {
                                            svgContent += `<circle cx="${x + jitter}" cy="${yScale(v)}" r="3" fill="#333" fill-opacity="0.7"/>`;
                                          } else {
                                            svgContent += `<circle cx="${x + jitter}" cy="${yScale(v)}" r="3" fill="white" stroke="#333" stroke-width="1"/>`;
                                          }
                                        });
                                      }
                                    }
                                  };

                                  drawBox(stats1, x1, '#3b82f6');
                                  drawBox(stats2, x2, '#ef4444');

                                  // 統計情報
                                  const testName = bothNormal ? 't-test' : 'Mann-Whitney U';
                                  svgContent += `<text x="${svgWidth - 10}" y="${svgHeight - 5}" text-anchor="end" font-size="9" fill="#666">${testName}, p=${pValue.toFixed(4)}</text>`;

                                    svgContent += '</svg>';

                                    return {
                                      itemName,
                                      svgContent,
                                      svgWidth,
                                      svgHeight,
                                      stats1,
                                      stats2,
                                      norm1,
                                      norm2,
                                      bothNormal,
                                      pValue,
                                      result
                                    };
                                  };

                                  // 各項目のグラフデータを生成
                                  const chartDataList = statSelectedItems.map((item, idx) => renderChart(item, idx)).filter(Boolean);

                                  if (chartDataList.length === 0) {
                                    return <div style={{padding: '20px', color: '#6b7280'}}>選択した項目にデータがありません</div>;
                                  }

                                  return (
                                    <div>
                                      {/* グラフをグリッド表示 */}
                                      <div style={{
                                        display: 'grid',
                                        gridTemplateColumns: chartDataList.length === 1 ? '1fr' : 'repeat(auto-fit, minmax(350px, 1fr))',
                                        gap: '20px',
                                        marginBottom: '20px'
                                      }}>
                                        {chartDataList.map((chartData, idx) => (
                                          <div key={idx} style={{
                                            background: '#fafafa',
                                            borderRadius: '8px',
                                            padding: '16px',
                                            border: '1px solid #e5e7eb'
                                          }}>
                                            {/* 正規性検定結果 */}
                                            <div style={{marginBottom: '8px', padding: '8px', background: '#f0fdf4', borderRadius: '4px', fontSize: '10px'}}>
                                              <strong>{chartData.itemName}</strong>: {chartData.bothNormal ? 't検定' : 'Mann-Whitney U'}, p={chartData.pValue.toFixed(4)}
                                              {chartData.pValue < 0.05 && <span style={{color: '#dc2626', marginLeft: '4px'}}>*</span>}
                                            </div>
                                            {/* グラフ */}
                                            <div
                                              style={{display: 'flex', justifyContent: 'center'}}
                                              dangerouslySetInnerHTML={{__html: chartData.svgContent}}
                                            />
                                          </div>
                                        ))}
                                      </div>

                                      {/* 一括エクスポートボタン */}
                                      <div style={{display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap', padding: '16px', background: '#f8fafc', borderRadius: '8px'}}>
                                        <button
                                          onClick={() => {
                                            // 全グラフを結合したSVGを作成
                                            const cols = Math.min(chartDataList.length, 3);
                                            const rows = Math.ceil(chartDataList.length / cols);
                                            const singleWidth = chartDataList[0].svgWidth;
                                            const singleHeight = chartDataList[0].svgHeight;
                                            const totalWidth = cols * singleWidth + (cols - 1) * 20;
                                            const totalHeight = rows * singleHeight + (rows - 1) * 20;

                                            let combinedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}">`;
                                            combinedSvg += `<rect width="100%" height="100%" fill="white"/>`;

                                            chartDataList.forEach((chart, idx) => {
                                              const col = idx % cols;
                                              const row = Math.floor(idx / cols);
                                              const x = col * (singleWidth + 20);
                                              const y = row * (singleHeight + 20);
                                              // SVGタグを除去して内容のみを取得
                                              const innerSvg = chart.svgContent.replace(/<svg[^>]*>/, '').replace(/<\/svg>/, '');
                                              combinedSvg += `<g transform="translate(${x}, ${y})">${innerSvg}</g>`;
                                            });
                                            combinedSvg += '</svg>';

                                            const blob = new Blob([combinedSvg], { type: 'image/svg+xml;charset=utf-8' });
                                            const url = URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = url;
                                            a.download = `統計グラフ_${statChartType}_${chartDataList.length}項目.svg`;
                                            a.click();
                                            URL.revokeObjectURL(url);
                                          }}
                                          style={{...styles.addButton, backgroundColor: '#7c3aed', padding: '10px 20px', fontSize: '13px'}}
                                        >
                                          🎨 全グラフSVG保存
                                        </button>
                                        <button
                                          onClick={() => {
                                            // 全グラフを結合したPNGを作成
                                            const cols = Math.min(chartDataList.length, 3);
                                            const rows = Math.ceil(chartDataList.length / cols);
                                            const singleWidth = chartDataList[0].svgWidth;
                                            const singleHeight = chartDataList[0].svgHeight;
                                            const totalWidth = cols * singleWidth + (cols - 1) * 20;
                                            const totalHeight = rows * singleHeight + (rows - 1) * 20;

                                            let combinedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}">`;
                                            combinedSvg += `<rect width="100%" height="100%" fill="white"/>`;

                                            chartDataList.forEach((chart, idx) => {
                                              const col = idx % cols;
                                              const row = Math.floor(idx / cols);
                                              const x = col * (singleWidth + 20);
                                              const y = row * (singleHeight + 20);
                                              const innerSvg = chart.svgContent.replace(/<svg[^>]*>/, '').replace(/<\/svg>/, '');
                                              combinedSvg += `<g transform="translate(${x}, ${y})">${innerSvg}</g>`;
                                            });
                                            combinedSvg += '</svg>';

                                            const canvas = document.createElement('canvas');
                                            canvas.width = totalWidth * 2;
                                            canvas.height = totalHeight * 2;
                                            const ctx = canvas.getContext('2d');
                                            ctx.scale(2, 2);
                                            const img = new Image();
                                            img.onload = () => {
                                              ctx.fillStyle = 'white';
                                              ctx.fillRect(0, 0, totalWidth, totalHeight);
                                              ctx.drawImage(img, 0, 0);
                                              const pngUrl = canvas.toDataURL('image/png');
                                              const a = document.createElement('a');
                                              a.href = pngUrl;
                                              a.download = `統計グラフ_${statChartType}_${chartDataList.length}項目.png`;
                                              a.click();
                                            };
                                            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(combinedSvg);
                                          }}
                                          style={{...styles.addButton, backgroundColor: '#0ea5e9', padding: '10px 20px', fontSize: '13px'}}
                                        >
                                          📷 全グラフPNG保存
                                        </button>
                                        <button
                                          onClick={() => {
                                            // 全項目のデータをExcelに出力
                                            const wb = XLSX.utils.book_new();

                                            // 各項目のデータシート
                                            chartDataList.forEach(chart => {
                                              // Group1
                                              const g1Data = [['ID', '日付', 'Day', chart.itemName]];
                                              (chart.result.group1.data || []).forEach(d => {
                                                g1Data.push([d.id, d.date, d.day, d.value]);
                                              });
                                              const wsG1 = XLSX.utils.aoa_to_sheet(g1Data);
                                              XLSX.utils.book_append_sheet(wb, wsG1, `${chart.itemName}_${selectedGroup1}`.substring(0, 31));

                                              // Group2
                                              const g2Data = [['ID', '日付', 'Day', chart.itemName]];
                                              (chart.result.group2.data || []).forEach(d => {
                                                g2Data.push([d.id, d.date, d.day, d.value]);
                                              });
                                              const wsG2 = XLSX.utils.aoa_to_sheet(g2Data);
                                              XLSX.utils.book_append_sheet(wb, wsG2, `${chart.itemName}_${selectedGroup2}`.substring(0, 31));
                                            });

                                            // 統計サマリーシート（全項目）
                                            const summaryData = [
                                              ['項目', 'n1', 'Mean1', 'SD1', 'n2', 'Mean2', 'SD2', '検定', 'p値', '有意差'],
                                            ];
                                            chartDataList.forEach(chart => {
                                              summaryData.push([
                                                chart.itemName,
                                                chart.stats1.n,
                                                chart.stats1.mean.toFixed(4),
                                                chart.stats1.sd.toFixed(4),
                                                chart.stats2.n,
                                                chart.stats2.mean.toFixed(4),
                                                chart.stats2.sd.toFixed(4),
                                                chart.bothNormal ? 't検定' : 'Mann-Whitney',
                                                chart.pValue.toFixed(6),
                                                chart.pValue < 0.05 ? '*' : ''
                                              ]);
                                            });
                                            const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
                                            XLSX.utils.book_append_sheet(wb, wsSummary, '統計サマリー');

                                            XLSX.writeFile(wb, `統計データ_${chartDataList.length}項目.xlsx`);
                                          }}
                                          style={{...styles.addButton, backgroundColor: '#10b981', padding: '10px 20px', fontSize: '13px'}}
                                        >
                                          📊 全データExcel保存
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })()}
                              </div>
                            </div>
                          )}

                          {comparisonResults && comparisonResults.length === 0 && (
                            <div style={{marginTop: '16px', padding: '16px', background: '#fef3c7', borderRadius: '8px', color: '#92400e', fontSize: '13px'}}>
                              選択した項目にデータがありません。
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </>
            )}

            <div style={styles.modalActions}>
              <button
                onClick={() => {
                  setShowAnalysisModal(false);
                  setAnalysisData(null);
                  setSelectedPatientIds([]);
                  setSelectedItems([]);
                  setComparisonResults(null);
                  setDayRangeStart('');
                  setDayRangeEnd('');
                }}
                style={styles.cancelButton}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 管理者パネルモーダル */}
      {showAdminPanel && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '600px'}}>
            <h2 style={styles.modalTitle}>⚙️ 管理者設定</h2>

            {/* 管理者設定セクション */}
            <div style={{marginBottom: '24px', padding: '16px', background: '#f8fafc', borderRadius: '8px'}}>
              <h3 style={{fontSize: '14px', fontWeight: '600', marginBottom: '12px', color: '#374151'}}>
                管理者アカウント
              </h3>
              {adminEmail ? (
                <div style={{fontSize: '13px', color: '#6b7280'}}>
                  現在の管理者: <strong style={{color: '#111827'}}>{adminEmail}</strong>
                  {isAdmin && <span style={{marginLeft: '8px', color: '#059669'}}>(あなた)</span>}
                </div>
              ) : (
                <div>
                  <p style={{fontSize: '13px', color: '#6b7280', marginBottom: '12px'}}>
                    管理者が設定されていません。自分を管理者として設定しますか？
                  </p>
                  <button
                    onClick={setAsAdmin}
                    disabled={isSettingAdmin}
                    style={{
                      ...styles.primaryButton,
                      backgroundColor: '#7c3aed',
                      padding: '8px 16px',
                      fontSize: '13px'
                    }}
                  >
                    {isSettingAdmin ? '設定中...' : '自分を管理者に設定'}
                  </button>
                </div>
              )}
            </div>

            {/* メール許可リスト設定 */}
            {(isAdmin || !adminEmail) && (
              <div style={{marginBottom: '24px', padding: '16px', background: '#f0fdf4', borderRadius: '8px'}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px'}}>
                  <h3 style={{fontSize: '14px', fontWeight: '600', color: '#374151', margin: 0}}>
                    メールアドレス許可リスト
                  </h3>
                  <label style={{display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer'}}>
                    <input
                      type="checkbox"
                      checked={emailAllowlistEnabled}
                      onChange={toggleEmailAllowlist}
                      style={{width: '18px', height: '18px'}}
                    />
                    <span style={{fontSize: '13px', color: emailAllowlistEnabled ? '#059669' : '#6b7280'}}>
                      {emailAllowlistEnabled ? '有効' : '無効'}
                    </span>
                  </label>
                </div>

                <p style={{fontSize: '12px', color: '#6b7280', marginBottom: '16px'}}>
                  有効にすると、許可リストに登録されたメールアドレスのみ新規登録できます。
                </p>

                {/* メールアドレス追加フォーム */}
                <div style={{display: 'flex', gap: '8px', marginBottom: '16px'}}>
                  <input
                    type="email"
                    value={newAllowedEmail}
                    onChange={(e) => setNewAllowedEmail(e.target.value)}
                    placeholder="example@email.com"
                    style={{...styles.input, flex: 1}}
                  />
                  <button
                    onClick={addAllowedEmail}
                    style={{
                      ...styles.addButton,
                      backgroundColor: '#10b981',
                      padding: '8px 16px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    追加
                  </button>
                </div>

                {/* 許可リスト一覧 */}
                <div style={{
                  maxHeight: '200px',
                  overflow: 'auto',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  background: 'white'
                }}>
                  {allowedEmails.length === 0 ? (
                    <div style={{padding: '16px', textAlign: 'center', color: '#6b7280', fontSize: '13px'}}>
                      許可されたメールアドレスはありません
                    </div>
                  ) : (
                    allowedEmails.map(item => (
                      <div
                        key={item.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 12px',
                          borderBottom: '1px solid #e5e7eb'
                        }}
                      >
                        <span style={{fontSize: '13px'}}>{item.email}</span>
                        <button
                          onClick={() => removeAllowedEmail(item.id)}
                          style={{
                            background: '#fee2e2',
                            color: '#dc2626',
                            border: 'none',
                            borderRadius: '4px',
                            padding: '4px 8px',
                            fontSize: '11px',
                            cursor: 'pointer'
                          }}
                        >
                          削除
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            <div style={styles.modalActions}>
              <button
                onClick={() => setShowAdminPanel(false)}
                style={styles.cancelButton}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 患者詳細画面
// ============================================================
function PatientDetailView({ patient, onBack }) {
  const { user } = useAuth();
  const [labResults, setLabResults] = useState([]);
  const [showAddLabModal, setShowAddLabModal] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const [ocrResults, setOcrResults] = useState(null);
  const [labDate, setLabDate] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [editingMemo, setEditingMemo] = useState(false);
  const [memoText, setMemoText] = useState(patient?.memo || '');
  const [editingPatientInfo, setEditingPatientInfo] = useState(false);
  const [editedPatient, setEditedPatient] = useState({
    diagnosis: patient?.diagnosis || '',
    group: patient?.group || '',
    onsetDate: patient?.onsetDate || '',
  });
  // 患者ID編集用state
  const [editingDisplayId, setEditingDisplayId] = useState(false);
  const [newDisplayId, setNewDisplayId] = useState(patient?.displayId || '');
  const [displayIdError, setDisplayIdError] = useState('');
  const [manualItems, setManualItems] = useState([]);
  const [manualItem, setManualItem] = useState({ item: '', value: '', unit: '' });

  // Excelインポート用state
  const [showExcelModal, setShowExcelModal] = useState(false);
  const [excelData, setExcelData] = useState(null);
  const [excelSheets, setExcelSheets] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [parsedExcelData, setParsedExcelData] = useState([]);
  const [isImporting, setIsImporting] = useState(false);

  // 既存検査データ編集用state
  const [editingLabId, setEditingLabId] = useState(null);
  const [editLabItem, setEditLabItem] = useState({ item: '', value: '', unit: '' });

  // 臨床経過用state
  const [clinicalEvents, setClinicalEvents] = useState([]);
  const [showAddEventModal, setShowAddEventModal] = useState(false);
  const [lastUsedDate, setLastUsedDate] = useState(''); // 最後に使用した日付を記憶
  const [newEvent, setNewEvent] = useState({
    eventType: '',
    customEventType: '',
    startDate: '',
    endDate: '',
    severity: '',
    jcs: '',
    frequency: '',
    presence: '',
    note: ''
  });
  const [editingEventId, setEditingEventId] = useState(null);
  const [editEvent, setEditEvent] = useState({
    eventType: '',
    startDate: '',
    endDate: '',
    severity: '',
    jcs: '',
    frequency: '',
    presence: '',
    note: ''
  });

  // イベント種類と入力形式の定義
  const eventTypeConfig = {
    '意識障害': { inputType: 'jcs', label: 'JCSスケール' },
    'てんかん発作': { inputType: 'frequency', label: '頻度' },
    '不随意運動': { inputType: 'frequency', label: '頻度' },
    '麻痺': { inputType: 'severity', label: '重症度' },
    '感覚障害': { inputType: 'severity', label: '重症度' },
    '失語': { inputType: 'severity', label: '重症度' },
    '認知機能障害': { inputType: 'severity', label: '重症度' },
    '精神症状': { inputType: 'severity', label: '重症度' },
    '発熱': { inputType: 'severity', label: '重症度' },
    '頭痛': { inputType: 'presence', label: '有無' },
    '髄膜刺激症状': { inputType: 'presence', label: '有無' },
    '人工呼吸器管理': { inputType: 'presence', label: '有無' },
    'ICU入室': { inputType: 'presence', label: '有無' },
    // 内分泌関連
    '低ナトリウム血症': { inputType: 'severity', label: '重症度' },
    '高ナトリウム血症': { inputType: 'severity', label: '重症度' },
    'SIADH': { inputType: 'presence', label: '有無' },
    '尿崩症': { inputType: 'presence', label: '有無' },
    '高血糖': { inputType: 'severity', label: '重症度' },
    '低血糖': { inputType: 'severity', label: '重症度' },
    '甲状腺機能低下': { inputType: 'presence', label: '有無' },
    '甲状腺機能亢進': { inputType: 'presence', label: '有無' },
    '副腎不全': { inputType: 'presence', label: '有無' },
    'その他': { inputType: 'custom', label: '' }
  };

  const [availableEventTypes, setAvailableEventTypes] = useState(Object.keys(eventTypeConfig));

  // JCSスケール選択肢
  const jcsOptions = [
    { value: '0', label: '0 (清明)' },
    { value: 'I-1', label: 'I-1 (見当識保たれるがボンヤリ)' },
    { value: 'I-2', label: 'I-2 (見当識障害あり)' },
    { value: 'I-3', label: 'I-3 (自分の名前・生年月日が言えない)' },
    { value: 'II-10', label: 'II-10 (普通の呼びかけで開眼)' },
    { value: 'II-20', label: 'II-20 (大声・体揺すりで開眼)' },
    { value: 'II-30', label: 'II-30 (痛み刺激+呼びかけでかろうじて開眼)' },
    { value: 'III-100', label: 'III-100 (痛み刺激で払いのける)' },
    { value: 'III-200', label: 'III-200 (痛み刺激で手足を動かす・顔をしかめる)' },
    { value: 'III-300', label: 'III-300 (痛み刺激に反応しない)' }
  ];

  // 頻度選択肢
  const frequencyOptions = [
    { value: 'hourly', label: '毎時間' },
    { value: 'several_daily', label: '1日数回' },
    { value: 'daily', label: '毎日' },
    { value: 'several_weekly', label: '週数回' },
    { value: 'weekly', label: '週1回' },
    { value: 'monthly', label: '月1回' },
    { value: 'rare', label: '稀' }
  ];

  // ========================================
  // 治療薬管理用state
  // ========================================
  const [treatments, setTreatments] = useState([]);
  const [showAddTreatmentModal, setShowAddTreatmentModal] = useState(false);
  const [lastUsedTreatmentDate, setLastUsedTreatmentDate] = useState('');
  const [newTreatment, setNewTreatment] = useState({
    parentCategory: '',
    category: '',
    medicationName: '',
    customMedication: '',
    dosage: '',
    dosageUnit: '',
    startDate: '',
    endDate: '',
    note: ''
  });
  const [editingTreatmentId, setEditingTreatmentId] = useState(null);
  const [editTreatment, setEditTreatment] = useState({
    category: '',
    medicationName: '',
    dosage: '',
    dosageUnit: '',
    startDate: '',
    endDate: '',
    note: ''
  });

  // プレゼン用統合タイムライン
  const [showClinicalTimeline, setShowClinicalTimeline] = useState(false);
  const timelineRef = useRef(null);

  // 経時データオーバーレイ用state
  const [showTimeSeriesOverlay, setShowTimeSeriesOverlay] = useState(false);
  const [selectedLabItemsForChart, setSelectedLabItemsForChart] = useState([]);
  const [showTreatmentsOnChart, setShowTreatmentsOnChart] = useState(false);
  const [selectedTreatmentsForChart, setSelectedTreatmentsForChart] = useState([]);
  const [showEventsOnChart, setShowEventsOnChart] = useState(false);
  const [selectedEventsForChart, setSelectedEventsForChart] = useState([]);
  const [timelinePosition, setTimelinePosition] = useState('below'); // 'above' or 'below'
  const [timelineDisplayMode, setTimelineDisplayMode] = useState('separate'); // 'separate' or 'overlay'
  const overlayChartRef = useRef(null);

  // 治療薬カテゴリと薬剤リスト
  // 治療薬の親カテゴリ（領域別）
  const treatmentParentCategories = {
    '神経系': ['抗てんかん薬', 'ステロイド', '免疫グロブリン', '血漿交換', '免疫抑制剤', '抗浮腫薬', 'ミトコンドリア治療', '栄養・微量元素補充'],
    '感染症': ['抗菌薬（ペニシリン系）', '抗菌薬（セフェム系）', '抗菌薬（カルバペネム系）', '抗菌薬（その他）', '抗ウイルス薬', '抗真菌薬'],
    'ICU/急性期': ['昇圧薬・強心薬', '鎮静薬・鎮痛薬', '筋弛緩薬', '血液製剤', '抗凝固薬'],
    '腎臓': ['透析関連', '利尿薬', '腎性貧血治療薬', 'ネフローゼ治療薬', '降圧薬'],
    '内分泌': ['ホルモン補充療法', '糖尿病治療薬', '電解質補正'],
    'その他': ['その他']
  };

  const treatmentCategories = {
    // === 神経系 ===
    '抗てんかん薬': {
      medications: [
        'バルプロ酸（デパケン）',
        'レベチラセタム（イーケプラ）',
        'ラコサミド（ビムパット）',
        'カルバマゼピン（テグレトール）',
        'フェニトイン（アレビアチン）',
        'フェノバルビタール',
        'クロバザム（マイスタン）',
        'クロナゼパム（リボトリール）',
        'ゾニサミド（エクセグラン）',
        'トピラマート（トピナ）',
        'ペランパネル（フィコンパ）',
        'ガバペンチン（ガバペン）',
        'ミダゾラム',
        'ジアゼパム（セルシン）',
        'ロラゼパム（ワイパックス）',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '神経系'
    },
    'ステロイド': {
      medications: [
        'IVMP（メチルプレドニゾロンパルス）',
        'PSL（プレドニゾロン）',
        'ベタメタゾン（リンデロン）',
        'デキサメタゾン（デカドロン）',
        'ヒドロコルチゾン（ソルコーテフ）',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '神経系'
    },
    '免疫グロブリン': {
      medications: [
        'IVIG（大量免疫グロブリン療法）',
        'その他'
      ],
      defaultUnit: 'mg/kg/日',
      parent: '神経系'
    },
    '血漿交換': {
      medications: [
        '単純血漿交換（PE）',
        '二重濾過血漿交換（DFPP）',
        '免疫吸着療法（IA）',
        'その他'
      ],
      defaultUnit: '回',
      noDosage: true,
      parent: '神経系'
    },
    '免疫抑制剤': {
      medications: [
        'タクロリムス（プログラフ）',
        'シクロスポリン（ネオーラル）',
        'アザチオプリン（イムラン）',
        'ミコフェノール酸モフェチル（セルセプト）',
        'シクロホスファミド（エンドキサン）',
        'リツキシマブ（リツキサン）',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '神経系'
    },
    '抗浮腫薬': {
      medications: [
        'グリセオール',
        'マンニトール',
        '高張食塩水',
        'その他'
      ],
      defaultUnit: 'mL/日',
      parent: '神経系'
    },
    'ミトコンドリア治療': {
      medications: [
        'ビタミンB1（チアミン）',
        'ビタミンB2（リボフラビン）',
        'ビタミンB12（コバラミン）',
        'ビタミンC（アスコルビン酸）',
        'ビタミンE（トコフェロール）',
        'コエンザイムQ10（ユビキノン）',
        'L-カルニチン（エルカルチン）',
        'L-アルギニン',
        'ビオチン',
        'αリポ酸',
        'ビタミンカクテル療法',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '神経系'
    },
    '栄養・微量元素補充': {
      medications: [
        '亜鉛製剤（ノベルジン/プロマック）',
        '銅製剤',
        'セレン製剤',
        '鉄剤（フェロミア等）',
        'カルニチン（エルカルチン）',
        '葉酸',
        'ビタミンD',
        '経腸栄養剤',
        '高カロリー輸液',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '神経系'
    },
    // === 感染症 ===
    '抗菌薬（ペニシリン系）': {
      medications: [
        'アンピシリン（ビクシリン）',
        'アモキシシリン（サワシリン）',
        'ピペラシリン（ペントシリン）',
        'ピペラシリン/タゾバクタム（ゾシン）',
        'アンピシリン/スルバクタム（ユナシン）',
        'アモキシシリン/クラブラン酸（オーグメンチン）',
        'その他'
      ],
      defaultUnit: 'g/日',
      parent: '感染症'
    },
    '抗菌薬（セフェム系）': {
      medications: [
        'セファゾリン（CEZ）',
        'セフォタキシム（CTX）',
        'セフトリアキソン（CTRX）',
        'セフェピム（CFPM）',
        'セフタジジム（CAZ）',
        'セフメタゾール（CMZ）',
        'その他'
      ],
      defaultUnit: 'g/日',
      parent: '感染症'
    },
    '抗菌薬（カルバペネム系）': {
      medications: [
        'メロペネム（MEPM）',
        'イミペネム/シラスタチン（IPM/CS）',
        'ドリペネム（DRPM）',
        'その他'
      ],
      defaultUnit: 'g/日',
      parent: '感染症'
    },
    '抗菌薬（その他）': {
      medications: [
        'バンコマイシン（VCM）',
        'テイコプラニン（TEIC）',
        'リネゾリド（LZD）',
        'ダプトマイシン（DAP）',
        'レボフロキサシン（LVFX）',
        'シプロフロキサシン（CPFX）',
        'アジスロマイシン（AZM）',
        'クリンダマイシン（CLDM）',
        'メトロニダゾール（MNZ）',
        'ST合剤（バクタ）',
        'その他'
      ],
      defaultUnit: 'g/日',
      parent: '感染症'
    },
    '抗ウイルス薬': {
      medications: [
        'アシクロビル（ゾビラックス）',
        'バラシクロビル（バルトレックス）',
        'ガンシクロビル',
        'バルガンシクロビル（バリキサ）',
        'オセルタミビル（タミフル）',
        'ラニナミビル（イナビル）',
        'レムデシビル（ベクルリー）',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '感染症'
    },
    '抗真菌薬': {
      medications: [
        'フルコナゾール（ジフルカン）',
        'ボリコナゾール（ブイフェンド）',
        'ミカファンギン（ファンガード）',
        'アムホテリシンB（ファンギゾン）',
        'リポソーマルアムホテリシンB（アムビゾーム）',
        'カスポファンギン（カンサイダス）',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '感染症'
    },
    // === ICU/急性期 ===
    '昇圧薬・強心薬': {
      medications: [
        'ノルアドレナリン（ノルアドリナリン）',
        'アドレナリン',
        'ドパミン（イノバン）',
        'ドブタミン（ドブトレックス）',
        'バソプレシン（ピトレシン）',
        'ミルリノン（ミルリーラ）',
        'その他'
      ],
      defaultUnit: 'μg/kg/min',
      parent: 'ICU/急性期'
    },
    '鎮静薬・鎮痛薬': {
      medications: [
        'プロポフォール（ディプリバン）',
        'ミダゾラム（ドルミカム）',
        'デクスメデトミジン（プレセデックス）',
        'フェンタニル',
        'レミフェンタニル（アルチバ）',
        'モルヒネ',
        'ケタミン',
        'その他'
      ],
      defaultUnit: 'mg/時',
      parent: 'ICU/急性期'
    },
    '筋弛緩薬': {
      medications: [
        'ロクロニウム（エスラックス）',
        'ベクロニウム（マスキュラックス）',
        'スガマデクス（ブリディオン）',
        'その他'
      ],
      defaultUnit: 'mg/時',
      parent: 'ICU/急性期'
    },
    '血液製剤': {
      medications: [
        '赤血球濃厚液（RBC）',
        '新鮮凍結血漿（FFP）',
        '血小板濃厚液（PC）',
        'アルブミン製剤',
        'その他'
      ],
      defaultUnit: '単位',
      parent: 'ICU/急性期'
    },
    '抗凝固薬': {
      medications: [
        'ヘパリン',
        'ワルファリン（ワーファリン）',
        'エドキサバン（リクシアナ）',
        'アピキサバン（エリキュース）',
        'リバーロキサバン（イグザレルト）',
        'ダビガトラン（プラザキサ）',
        'アルガトロバン（スロンノン）',
        'その他'
      ],
      defaultUnit: '単位/時',
      parent: 'ICU/急性期'
    },
    // === 腎臓 ===
    '透析関連': {
      medications: [
        '血液透析（HD）',
        '持続血液透析濾過（CHDF）',
        '腹膜透析（PD）',
        '血漿交換（腎）',
        'その他'
      ],
      defaultUnit: '回/週',
      noDosage: true,
      parent: '腎臓'
    },
    '利尿薬': {
      medications: [
        'フロセミド（ラシックス）',
        'アゾセミド（ダイアート）',
        'トルバプタン（サムスカ）',
        'スピロノラクトン（アルダクトン）',
        'トリクロルメチアジド（フルイトラン）',
        'カルペリチド（ハンプ）',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '腎臓'
    },
    '腎性貧血治療薬': {
      medications: [
        'ダルベポエチンα（ネスプ）',
        'エポエチンβペゴル（ミルセラ）',
        'ロキサデュスタット（エベレンゾ）',
        'ダプロデュスタット（ダーブロック）',
        '鉄剤（静注）',
        'その他'
      ],
      defaultUnit: 'μg/回',
      parent: '腎臓'
    },
    'ネフローゼ治療薬': {
      medications: [
        'プレドニゾロン',
        'メチルプレドニゾロン（パルス）',
        'シクロスポリン（ネオーラル）',
        'タクロリムス（プログラフ）',
        'ミコフェノール酸モフェチル（セルセプト）',
        'シクロホスファミド',
        'リツキシマブ（リツキサン）',
        'アルブミン製剤',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '腎臓'
    },
    '降圧薬': {
      medications: [
        'エナラプリル（レニベース）',
        'リシノプリル（ロンゲス）',
        'ロサルタン（ニューロタン）',
        'バルサルタン（ディオバン）',
        'オルメサルタン（オルメテック）',
        'アムロジピン（ノルバスク）',
        'ニフェジピン（アダラート）',
        'アテノロール（テノーミン）',
        'カルベジロール（アーチスト）',
        'ビソプロロール（メインテート）',
        'スピロノラクトン（アルダクトン）',
        'エプレレノン（セララ）',
        'ドキサゾシン（カルデナリン）',
        'ヒドララジン',
        'その他'
      ],
      defaultUnit: 'mg/日',
      parent: '腎臓'
    },
    // === 内分泌 ===
    'ホルモン補充療法': {
      medications: [
        'レボチロキシン（チラーヂン）',
        'リオチロニン（チロナミン）',
        'ヒドロコルチゾン（コートリル）',
        'デスモプレシン（ミニリンメルト）',
        'フルドロコルチゾン（フロリネフ）',
        'その他'
      ],
      defaultUnit: 'μg/日',
      parent: '内分泌'
    },
    '糖尿病治療薬': {
      medications: [
        'インスリン（速効型）',
        'インスリン（持効型）',
        'インスリン（混合型）',
        'メトホルミン',
        'DPP-4阻害薬',
        'SGLT2阻害薬',
        'GLP-1受容体作動薬',
        'SU薬',
        'チアゾリジン薬',
        'その他'
      ],
      defaultUnit: '単位/日',
      parent: '内分泌'
    },
    '電解質補正': {
      medications: [
        '塩化ナトリウム（生理食塩水）',
        '高張食塩水（3%NaCl）',
        '塩化カリウム',
        'リン酸製剤',
        'カルシウム製剤',
        '水分制限',
        'トルバプタン（サムスカ）',
        'その他'
      ],
      defaultUnit: 'mEq/日',
      parent: '内分泌'
    },
    // === その他 ===
    'その他': {
      medications: [],
      defaultUnit: '',
      parent: 'その他'
    }
  };

  // 投与量単位の選択肢
  const dosageUnits = [
    'mg/日',
    'mg/回',
    'mg/kg/日',
    'mg/kg',
    'g/日',
    'g/kg/日',
    'g/kg',
    'mL/日',
    '回',
    '単位/日',
    'μg/日',
    'μg/kg/min',
    'γ（μg/kg/min）',
    'mg/時',
    'mL/時',
    '単位/時',
    'その他'
  ];

  // 検査データをリアルタイム取得
  useEffect(() => {
    if (!user || !patient) return;

    const q = query(
      collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
      orderBy('date', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const labData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setLabResults(labData);
    });

    return unsubscribe;
  }, [user, patient]);

  // 臨床経過データをリアルタイム取得
  useEffect(() => {
    if (!user || !patient) return;

    const q = query(
      collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
      orderBy('startDate', 'asc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const eventsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setClinicalEvents(eventsData);
    });

    return unsubscribe;
  }, [user, patient]);

  // 治療薬データをリアルタイム取得
  useEffect(() => {
    if (!user || !patient) return;

    const q = query(
      collection(db, 'users', user.uid, 'patients', patient.id, 'treatments'),
      orderBy('startDate', 'asc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const treatmentData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setTreatments(treatmentData);
    });

    return unsubscribe;
  }, [user, patient]);

  // 新規イベント追加モーダルを開く（日付を自動入力）
  const openAddEventModal = () => {
    setNewEvent({
      eventType: '',
      customEventType: '',
      startDate: lastUsedDate || '', // 最後に使用した日付を自動入力
      endDate: '',
      severity: '',
      jcs: '',
      frequency: '',
      presence: '',
      note: ''
    });
    setShowAddEventModal(true);
  };

  // イベントをコピーして新規追加モーダルを開く
  const copyEvent = (event) => {
    // イベントタイプが定義済みかカスタムか判定
    const isCustomType = !Object.keys(eventTypeConfig).includes(event.eventType);

    setNewEvent({
      eventType: isCustomType ? 'その他' : event.eventType,
      customEventType: isCustomType ? event.eventType : '',
      startDate: event.startDate || lastUsedDate || '',
      endDate: event.endDate || '',
      severity: event.severity || '',
      jcs: event.jcs || '',
      frequency: event.frequency || '',
      presence: event.presence || '',
      note: '' // メモはコピーしない
    });
    setShowAddEventModal(true);
  };

  // 臨床経過イベントを追加
  const addClinicalEvent = async () => {
    const eventType = newEvent.eventType === 'その他' ? newEvent.customEventType : newEvent.eventType;
    if (!eventType || !newEvent.startDate) {
      alert('イベント種類と開始日は必須です');
      return;
    }

    const config = eventTypeConfig[newEvent.eventType] || { inputType: 'severity' };

    try {
      await addDoc(
        collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
        {
          eventType: eventType,
          inputType: config.inputType,
          startDate: newEvent.startDate,
          endDate: newEvent.endDate || null,
          severity: newEvent.severity || null,
          jcs: newEvent.jcs || null,
          frequency: newEvent.frequency || null,
          presence: newEvent.presence || null,
          note: newEvent.note || '',
          createdAt: serverTimestamp()
        }
      );

      // 最後に使用した日付を記憶
      setLastUsedDate(newEvent.startDate);

      // カスタムイベントタイプを追加
      if (newEvent.eventType === 'その他' && newEvent.customEventType) {
        if (!availableEventTypes.includes(newEvent.customEventType)) {
          setAvailableEventTypes([...availableEventTypes.slice(0, -1), newEvent.customEventType, 'その他']);
        }
      }

      setNewEvent({
        eventType: '',
        customEventType: '',
        startDate: '',
        endDate: '',
        severity: '',
        jcs: '',
        frequency: '',
        presence: '',
        note: ''
      });
      setShowAddEventModal(false);
    } catch (err) {
      console.error('Error adding clinical event:', err);
      alert('イベントの追加に失敗しました');
    }
  };

  // 臨床経過イベントを削除
  const deleteClinicalEvent = async (eventId) => {
    if (!confirm('このイベントを削除しますか？')) return;

    try {
      await deleteDoc(
        doc(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents', eventId)
      );
    } catch (err) {
      console.error('Error deleting clinical event:', err);
    }
  };

  // 臨床経過イベントの編集を開始
  const startEditEvent = (event) => {
    setEditingEventId(event.id);
    setEditEvent({
      eventType: event.eventType || '',
      startDate: event.startDate || '',
      endDate: event.endDate || '',
      severity: event.severity || '',
      jcs: event.jcs || '',
      frequency: event.frequency || '',
      presence: event.presence || '',
      note: event.note || ''
    });
  };

  // 臨床経過イベントの編集をキャンセル
  const cancelEditEvent = () => {
    setEditingEventId(null);
    setEditEvent({
      eventType: '',
      startDate: '',
      endDate: '',
      severity: '',
      jcs: '',
      frequency: '',
      presence: '',
      note: ''
    });
  };

  // 臨床経過イベントを更新
  const updateClinicalEvent = async () => {
    if (!editEvent.eventType || !editEvent.startDate) {
      alert('イベント種類と開始日は必須です');
      return;
    }

    try {
      await updateDoc(
        doc(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents', editingEventId),
        {
          eventType: editEvent.eventType,
          startDate: editEvent.startDate,
          endDate: editEvent.endDate || null,
          severity: editEvent.severity || null,
          jcs: editEvent.jcs || null,
          frequency: editEvent.frequency || null,
          presence: editEvent.presence || null,
          note: editEvent.note || ''
        }
      );
      cancelEditEvent();
    } catch (err) {
      console.error('Error updating clinical event:', err);
      alert('イベントの更新に失敗しました');
    }
  };

  // 臨床経過CSVエクスポート
  const exportClinicalEventsCSV = () => {
    if (clinicalEvents.length === 0) {
      alert('エクスポートするデータがありません');
      return;
    }

    const headers = ['EventType', 'InputType', 'StartDate', 'EndDate', 'JCS', 'Frequency', 'Severity', 'Presence', 'Note'];
    const rows = clinicalEvents.map(e => [
      e.eventType || '',
      e.inputType || '',
      e.startDate || '',
      e.endDate || '',
      e.jcs || '',
      e.frequency || '',
      e.severity || '',
      e.presence || '',
      (e.note || '').replace(/,/g, '，').replace(/\n/g, ' ')
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const bom = '\uFEFF';
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${patient.displayId}_clinical_events.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 臨床経過CSVインポート
  const importClinicalEventsCSV = async (file) => {
    const text = await file.text();
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      alert('データが見つかりません');
      return;
    }

    const headers = lines[0].split(',').map(h => h.trim().replace(/^"/, '').replace(/"$/, ''));
    const eventTypeIdx = headers.findIndex(h => h.toLowerCase() === 'eventtype');
    const inputTypeIdx = headers.findIndex(h => h.toLowerCase() === 'inputtype');
    const startDateIdx = headers.findIndex(h => h.toLowerCase() === 'startdate');
    const endDateIdx = headers.findIndex(h => h.toLowerCase() === 'enddate');
    const jcsIdx = headers.findIndex(h => h.toLowerCase() === 'jcs');
    const frequencyIdx = headers.findIndex(h => h.toLowerCase() === 'frequency');
    const severityIdx = headers.findIndex(h => h.toLowerCase() === 'severity');
    const presenceIdx = headers.findIndex(h => h.toLowerCase() === 'presence');
    const noteIdx = headers.findIndex(h => h.toLowerCase() === 'note');

    if (eventTypeIdx === -1 || startDateIdx === -1) {
      alert('必須列（EventType, StartDate）が見つかりません');
      return;
    }

    let imported = 0;
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/^"/, '').replace(/"$/, ''));
      const eventType = values[eventTypeIdx];
      const startDate = values[startDateIdx];

      if (!eventType || !startDate) continue;

      try {
        await addDoc(
          collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
          {
            eventType: eventType,
            inputType: inputTypeIdx !== -1 ? values[inputTypeIdx] || 'severity' : 'severity',
            startDate: startDate,
            endDate: endDateIdx !== -1 ? values[endDateIdx] || null : null,
            jcs: jcsIdx !== -1 ? values[jcsIdx] || null : null,
            frequency: frequencyIdx !== -1 ? values[frequencyIdx] || null : null,
            severity: severityIdx !== -1 ? values[severityIdx] || null : null,
            presence: presenceIdx !== -1 ? values[presenceIdx] || null : null,
            note: noteIdx !== -1 ? values[noteIdx] || '' : '',
            createdAt: serverTimestamp()
          }
        );
        imported++;
      } catch (err) {
        console.error('Error importing event:', err);
      }
    }

    alert(`${imported}件のイベントをインポートしました`);
  };

  // 臨床経過CSVサンプルダウンロード
  const downloadClinicalEventsSample = () => {
    const sampleData = [
      ['EventType', 'InputType', 'StartDate', 'EndDate', 'JCS', 'Frequency', 'Severity', 'Presence', 'Note'],
      ['てんかん発作', 'frequency', '2024-01-15', '2024-01-20', '', 'daily', '', '', '発熱時に増悪'],
      ['てんかん発作', 'frequency', '2024-01-21', '2024-01-25', '', 'weekly', '', '', '改善傾向'],
      ['意識障害', 'jcs', '2024-01-15', '2024-01-18', 'II-10', '', '', '', ''],
      ['意識障害', 'jcs', '2024-01-19', '2024-01-22', 'I-3', '', '', '', '改善'],
      ['不随意運動', 'presence', '2024-01-16', '2024-01-25', '', '', '', 'あり', '舞踏様運動'],
      ['発熱', 'severity', '2024-01-15', '2024-01-17', '', '', '重度', '', '39度台'],
      ['発熱', 'severity', '2024-01-18', '2024-01-20', '', '', '軽度', '', '37度台'],
      ['頭痛', 'severity', '2024-01-15', '2024-01-22', '', '', '中等度', '', ''],
      ['麻痺', 'severity', '2024-01-16', '', '', '', '軽度', '', '右上肢'],
    ];

    const csvContent = sampleData.map(row => row.join(',')).join('\n');
    const bom = '\uFEFF';
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'clinical_events_sample.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // ========================================
  // 治療薬管理関数
  // ========================================

  // 治療薬追加モーダルを開く（日付を自動入力）
  const openAddTreatmentModal = () => {
    setNewTreatment({
      category: '',
      medicationName: '',
      customMedication: '',
      dosage: '',
      dosageUnit: '',
      startDate: lastUsedTreatmentDate || '',
      endDate: '',
      note: ''
    });
    setShowAddTreatmentModal(true);
  };

  // 治療薬をコピーして新規追加モーダルを開く
  const copyTreatment = (treatment) => {
    // カテゴリと薬剤名の判定
    let category = treatment.category || 'その他';
    let medicationName = treatment.medicationName || '';
    let customMedication = '';

    // その他カテゴリか、カテゴリ内にない薬剤の場合
    if (category === 'その他' ||
        (treatmentCategories[category] &&
         !treatmentCategories[category].medications.includes(medicationName))) {
      customMedication = medicationName;
      if (category !== 'その他') {
        medicationName = 'その他';
      }
    }

    setNewTreatment({
      category: category,
      medicationName: medicationName,
      customMedication: customMedication,
      dosage: '', // 容量は空にして再入力を促す
      dosageUnit: treatment.dosageUnit || '',
      startDate: treatment.startDate || lastUsedTreatmentDate || '',
      endDate: treatment.endDate || '',
      note: ''
    });
    setShowAddTreatmentModal(true);
  };

  // 治療薬を追加
  const addTreatment = async () => {
    const medicationName = newTreatment.medicationName === 'その他'
      ? newTreatment.customMedication
      : newTreatment.medicationName;

    if (!newTreatment.category || !medicationName || !newTreatment.startDate) {
      alert('カテゴリ、薬剤名、開始日は必須です');
      return;
    }

    try {
      await addDoc(
        collection(db, 'users', user.uid, 'patients', patient.id, 'treatments'),
        {
          category: newTreatment.category,
          medicationName: medicationName,
          dosage: newTreatment.dosage || null,
          dosageUnit: newTreatment.dosageUnit || null,
          startDate: newTreatment.startDate,
          endDate: newTreatment.endDate || null,
          note: newTreatment.note || '',
          createdAt: serverTimestamp()
        }
      );

      // 最後に使用した日付を記憶
      setLastUsedTreatmentDate(newTreatment.startDate);

      setNewTreatment({
        category: '',
        medicationName: '',
        customMedication: '',
        dosage: '',
        dosageUnit: '',
        startDate: '',
        endDate: '',
        note: ''
      });
      setShowAddTreatmentModal(false);
    } catch (err) {
      console.error('Error adding treatment:', err);
      alert('治療薬の追加に失敗しました');
    }
  };

  // 治療薬を削除
  const deleteTreatment = async (treatmentId) => {
    if (!confirm('この治療薬記録を削除しますか？')) return;

    try {
      await deleteDoc(
        doc(db, 'users', user.uid, 'patients', patient.id, 'treatments', treatmentId)
      );
    } catch (err) {
      console.error('Error deleting treatment:', err);
    }
  };

  // 治療薬の編集を開始
  const startEditTreatment = (treatment) => {
    setEditingTreatmentId(treatment.id);
    setEditTreatment({
      category: treatment.category || '',
      medicationName: treatment.medicationName || '',
      dosage: treatment.dosage || '',
      dosageUnit: treatment.dosageUnit || '',
      startDate: treatment.startDate || '',
      endDate: treatment.endDate || '',
      note: treatment.note || ''
    });
  };

  // 治療薬の編集をキャンセル
  const cancelEditTreatment = () => {
    setEditingTreatmentId(null);
    setEditTreatment({
      category: '',
      medicationName: '',
      dosage: '',
      dosageUnit: '',
      startDate: '',
      endDate: '',
      note: ''
    });
  };

  // 治療薬を更新
  const updateTreatment = async () => {
    if (!editTreatment.medicationName || !editTreatment.startDate) {
      alert('薬剤名と開始日は必須です');
      return;
    }

    try {
      await updateDoc(
        doc(db, 'users', user.uid, 'patients', patient.id, 'treatments', editingTreatmentId),
        {
          category: editTreatment.category,
          medicationName: editTreatment.medicationName,
          dosage: editTreatment.dosage || null,
          dosageUnit: editTreatment.dosageUnit || null,
          startDate: editTreatment.startDate,
          endDate: editTreatment.endDate || null,
          note: editTreatment.note || ''
        }
      );
      cancelEditTreatment();
    } catch (err) {
      console.error('Error updating treatment:', err);
      alert('治療薬の更新に失敗しました');
    }
  };

  // 同じ薬剤の投与量履歴を取得（グラフ用）
  const getMedicationDosageHistory = (medicationName) => {
    return treatments
      .filter(t => t.medicationName === medicationName && t.dosage)
      .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))
      .map(t => ({
        date: t.startDate,
        dosage: parseFloat(t.dosage),
        unit: t.dosageUnit,
        dayFromOnset: calcDaysFromOnset(t.startDate)
      }));
  };

  // 発症日からの日数を計算
  const calcDaysFromOnset = (dateStr) => {
    if (!patient.onsetDate || !dateStr) return null;
    const onset = new Date(patient.onsetDate);
    const date = new Date(dateStr);
    return Math.ceil((date - onset) / (1000 * 60 * 60 * 24));
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setSelectedImage(URL.createObjectURL(file));
    setIsProcessing(true);
    setOcrProgress(0);

    const result = await performOCR(file, setOcrProgress);
    
    if (result.success) {
      setOcrResults(result.data);
    } else {
      console.error('OCR failed:', result.error);
      setOcrResults([]);
    }
    
    setIsProcessing(false);
  };

  const addManualItem = () => {
    if (!manualItem.item || !manualItem.value) return;
    
    const newItem = {
      item: manualItem.item.toUpperCase(),
      value: parseFloat(manualItem.value),
      unit: manualItem.unit || labItemUnits[manualItem.item.toUpperCase()] || ''
    };
    
    if (ocrResults) {
      setOcrResults([...ocrResults, newItem]);
    } else {
      setOcrResults([newItem]);
    }
    
    setManualItem({ item: '', value: '', unit: '' });
  };

  const saveLabResults = async () => {
    if (!ocrResults || ocrResults.length === 0 || !labDate) return;

    try {
      await addDoc(
        collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
        {
          date: labDate,
          data: ocrResults,
          createdAt: serverTimestamp()
        }
      );

      // 患者の検査件数を更新
      await updateDoc(doc(db, 'users', user.uid, 'patients', patient.id), {
        labCount: (labResults.length || 0) + 1
      });

      setShowAddLabModal(false);
      setOcrResults(null);
      setSelectedImage(null);
      setLabDate('');
    } catch (err) {
      console.error('Error saving lab results:', err);
    }
  };

  // ============================================
  // Excelインポート機能
  // ============================================

  // 検査データ用サンプルExcelダウンロード
  const downloadLabDataSample = () => {
    const wb = XLSX.utils.book_new();

    // Serum（血清）シート
    const serumData = [
      ['検査項目', '単位', 'Day1', 'Day2', 'Day3', 'Day5', 'Day7', 'Day14'],
      ['採取日', '', '2024-01-15', '2024-01-16', '2024-01-17', '2024-01-19', '2024-01-21', '2024-01-28'],
      ['WBC', '/μL', '12000', '10500', '9800', '8500', '7200', '6500'],
      ['RBC', '×10^4/μL', '450', '448', '445', '450', '455', '460'],
      ['Hb', 'g/dL', '13.5', '13.2', '13.0', '13.3', '13.5', '13.8'],
      ['Plt', '×10^4/μL', '18.5', '17.8', '16.5', '18.0', '20.5', '22.0'],
      ['CRP', 'mg/dL', '8.5', '6.2', '4.1', '1.8', '0.5', '0.1'],
      ['AST', 'U/L', '45', '42', '38', '32', '28', '25'],
      ['ALT', 'U/L', '52', '48', '42', '35', '30', '28'],
      ['BUN', 'mg/dL', '18', '16', '15', '14', '13', '12'],
      ['Cr', 'mg/dL', '0.8', '0.75', '0.72', '0.70', '0.68', '0.65'],
      ['Na', 'mEq/L', '138', '139', '140', '141', '140', '140'],
      ['K', 'mEq/L', '4.2', '4.0', '4.1', '4.0', '4.1', '4.0'],
      ['Cl', 'mEq/L', '102', '103', '103', '104', '103', '103'],
      ['Glucose', 'mg/dL', '120', '110', '105', '100', '98', '95'],
    ];
    const wsSerum = XLSX.utils.aoa_to_sheet(serumData);
    XLSX.utils.book_append_sheet(wb, wsSerum, 'Serum');

    // CSF（髄液）シート
    const csfData = [
      ['検査項目', '単位', 'Day1', 'Day7', 'Day14'],
      ['採取日', '', '2024-01-15', '2024-01-21', '2024-01-28'],
      ['細胞数', '/μL', '150', '45', '12'],
      ['蛋白', 'mg/dL', '85', '55', '42'],
      ['糖', 'mg/dL', '55', '60', '65'],
      ['IgG Index', '', '1.2', '0.9', '0.7'],
      ['OCB', '', '陽性', '陽性', '陰性'],
    ];
    const wsCSF = XLSX.utils.aoa_to_sheet(csfData);
    XLSX.utils.book_append_sheet(wb, wsCSF, 'CSF');

    // 説明シート
    const instructions = [
      ['検査データExcelフォーマット説明'],
      [''],
      ['■ 基本構造'],
      ['・1行目: ヘッダー行（検査項目, 単位, Day1, Day2, ...）'],
      ['・2行目: 採取日行（採取日, 空欄, 日付, 日付, ...）'],
      ['・3行目以降: 検査項目データ'],
      [''],
      ['■ 日付形式'],
      ['・YYYY-MM-DD形式を推奨（例: 2024-01-15）'],
      ['・Excelの日付形式も対応'],
      [''],
      ['■ シート名'],
      ['・シート名に「CSF」を含むと髄液として認識'],
      ['・シート名に「Serum」を含むと血清として認識'],
      [''],
      ['■ 複数日のデータ'],
      ['・Day1, Day2, ... の列で複数日のデータを一括入力可能'],
    ];
    const wsInst = XLSX.utils.aoa_to_sheet(instructions);
    XLSX.utils.book_append_sheet(wb, wsInst, '説明');

    XLSX.writeFile(wb, 'lab_data_sample.xlsx');
  };

  const handleExcelUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = evt.target.result;
      const workbook = XLSX.read(data, { type: 'array' });
      setExcelData(workbook);
      setExcelSheets(workbook.SheetNames);
      setSelectedSheet(workbook.SheetNames[0]);
      parseExcelSheet(workbook, workbook.SheetNames[0]);
    };
    reader.readAsArrayBuffer(file);
  };

  const parseExcelSheet = (workbook, sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // シート名から検体タイプを判定
    const specimenType = sheetName.includes('CSF') ? 'CSF' :
                         sheetName.includes('Serum') ? 'Serum' : '';

    // ヘッダー行を探す（検査項目を含む行）
    let headerRowIndex = -1;
    let dateRowIndex = -1;

    for (let i = 0; i < Math.min(15, jsonData.length); i++) {
      const row = jsonData[i];
      if (row && row[0] === '検査項目') {
        headerRowIndex = i;
      }
      if (row && row[0] === '採取日') {
        dateRowIndex = i;
      }
    }

    if (headerRowIndex === -1) {
      console.log('ヘッダー行が見つかりません');
      setParsedExcelData([]);
      return;
    }

    const headerRow = jsonData[headerRowIndex];
    const dateRow = dateRowIndex !== -1 ? jsonData[dateRowIndex] : null;

    // 単位列のインデックスを検出（「単位」が含まれる列を探す）
    let unitColumnIndex = 1;
    for (let i = 1; i < Math.min(5, headerRow.length); i++) {
      if (headerRow[i] && headerRow[i].toString().includes('単位')) {
        unitColumnIndex = i;
        break;
      }
    }

    // データ列の開始インデックス（単位列の次から）
    const dataStartIndex = unitColumnIndex + 1;

    // 日付列のインデックスを取得
    const dateColumns = [];
    for (let i = dataStartIndex; i < headerRow.length; i++) {
      const headerValue = headerRow[i];
      if (!headerValue) continue;

      const headerStr = headerValue.toString();
      let formattedDate = '';
      let dayLabel = '';

      // パターン1: Day1, Day2 形式（従来形式）
      if (headerStr.startsWith('Day')) {
        dayLabel = headerStr;
        if (dateRow && dateRow[i]) {
          const dateValue = dateRow[i];
          if (typeof dateValue === 'number') {
            const date = XLSX.SSF.parse_date_code(dateValue);
            formattedDate = `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
          } else {
            formattedDate = dateValue.toString().replace(/\//g, '-');
          }
        }
      }
      // パターン2: ヘッダーに日付が直接含まれている形式（例: "2025-06-15\n初診時"）
      else {
        // 日付パターンを抽出（YYYY-MM-DD または YYYY/MM/DD）
        const dateMatch = headerStr.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/);
        if (dateMatch) {
          formattedDate = dateMatch[1].replace(/\//g, '-');
          // 改行以降のテキストをラベルとして使用
          const labelMatch = headerStr.split(/[\n\r]+/);
          dayLabel = labelMatch.length > 1 ? labelMatch[1].trim() : formattedDate;
        }
      }

      if (formattedDate) {
        dateColumns.push({
          index: i,
          day: dayLabel,
          date: formattedDate
        });
      }
    }

    console.log('Detected date columns:', dateColumns);

    // 検査データを抽出
    const labDataByDate = {};

    for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row || !row[0]) continue;

      const itemName = row[0].toString().trim();
      const unit = row[unitColumnIndex] ? row[unitColumnIndex].toString() : '';

      // セクションヘッダーや空行をスキップ
      if (itemName.startsWith('【') || itemName === '' || itemName === '検査項目') continue;

      // 日付パターンをスキップ（様々な形式に対応）
      if (/\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2}/.test(itemName)) continue;  // 2024-01-01, 2024.01.01形式（文字列のどこかに含まれていればスキップ）
      if (/^Day\s*\d+/i.test(itemName)) continue;  // Day 1形式
      if (/^\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4}/.test(itemName)) continue;  // 01/01/2024形式
      if (/^\d+$/.test(itemName) && parseInt(itemName) > 30000) continue;  // Excelのシリアル日付
      if (/^(ベースライン|baseline|治療前|治療後|初診|入院|退院)/i.test(itemName)) continue;  // 時間ラベル
      if (/\d+[日週ヶ月年]後?/.test(itemName)) continue;  // 1ヶ月後などの時間ラベル（文字列のどこかに含まれていればスキップ）
      if (/^(基準値|単位|患者|診断|発症|採取|検体|参考値|正常値)/.test(itemName)) continue;  // ヘッダー関連
      if (/\r?\n/.test(itemName)) continue;  // 改行を含む（日付+ラベルの複合セル）
      // 日本語の日付形式
      if (/\d{1,2}月\d{1,2}日/.test(itemName)) continue;  // 1月1日形式
      if (/令和|平成|昭和/.test(itemName)) continue;  // 和暦

      for (const col of dateColumns) {
        const value = row[col.index];
        // 数値として解析可能かチェック（文字列の数値も含む）
        const numValue = parseFloat(String(value).replace(/,/g, ''));
        if (value !== undefined && value !== null && value !== '' && !isNaN(numValue)) {
          if (!labDataByDate[col.date]) {
            labDataByDate[col.date] = {
              date: col.date,
              day: col.day,
              specimen: specimenType,
              data: []
            };
          }

          labDataByDate[col.date].data.push({
            item: itemName,
            value: numValue,
            unit: unit
          });
        }
      }
    }

    const result = Object.values(labDataByDate).sort((a, b) => a.date.localeCompare(b.date));
    console.log('Parsed Excel Data:', result);
    setParsedExcelData(result);
  };

  const handleSheetChange = (sheetName) => {
    setSelectedSheet(sheetName);
    if (excelData) {
      parseExcelSheet(excelData, sheetName);
    }
  };

  const importExcelData = async () => {
    if (parsedExcelData.length === 0) return;

    setIsImporting(true);

    try {
      for (const dayData of parsedExcelData) {
        if (dayData.data.length === 0) continue;

        await addDoc(
          collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
          {
            date: dayData.date,
            specimen: dayData.specimen || '',
            data: dayData.data,
            source: 'excel',
            createdAt: serverTimestamp()
          }
        );
      }

      // 患者の検査件数を更新
      await updateDoc(doc(db, 'users', user.uid, 'patients', patient.id), {
        labCount: (labResults.length || 0) + parsedExcelData.length
      });

      setShowExcelModal(false);
      setExcelData(null);
      setExcelSheets([]);
      setParsedExcelData([]);
      alert(`${parsedExcelData.length}件の検査データをインポートしました`);
    } catch (err) {
      console.error('Error importing Excel data:', err);
      alert('インポートに失敗しました');
    }

    setIsImporting(false);
  };

  const deleteLabResult = async (labId) => {
    if (!confirm('この検査データを削除しますか？')) return;

    try {
      await deleteDoc(
        doc(db, 'users', user.uid, 'patients', patient.id, 'labResults', labId)
      );

      await updateDoc(doc(db, 'users', user.uid, 'patients', patient.id), {
        labCount: Math.max((labResults.length || 1) - 1, 0)
      });
    } catch (err) {
      console.error('Error deleting lab result:', err);
    }
  };

  // 全検査データを一括削除
  const deleteAllLabResults = async () => {
    if (!confirm(`この患者の全検査データ（${labResults.length}件）を削除しますか？この操作は取り消せません。`)) return;

    try {
      for (const lab of labResults) {
        await deleteDoc(
          doc(db, 'users', user.uid, 'patients', patient.id, 'labResults', lab.id)
        );
      }

      await updateDoc(doc(db, 'users', user.uid, 'patients', patient.id), {
        labCount: 0
      });
      alert('全検査データを削除しました');
    } catch (err) {
      console.error('Error deleting all lab results:', err);
      alert('削除に失敗しました');
    }
  };

  // 既存の検査データに項目を追加
  const addItemToLabResult = async (labId) => {
    if (!editLabItem.item || !editLabItem.value) return;

    const lab = labResults.find(l => l.id === labId);
    if (!lab) return;

    const newItem = {
      item: editLabItem.item.toUpperCase(),
      value: parseFloat(editLabItem.value) || editLabItem.value,
      unit: editLabItem.unit || labItemUnits[editLabItem.item.toUpperCase()] || ''
    };

    const updatedData = [...(lab.data || []), newItem];

    try {
      await updateDoc(
        doc(db, 'users', user.uid, 'patients', patient.id, 'labResults', labId),
        { data: updatedData }
      );
      setEditLabItem({ item: '', value: '', unit: '' });
    } catch (err) {
      console.error('Error adding item to lab result:', err);
      alert('項目の追加に失敗しました');
    }
  };

  // 既存の検査データから項目を削除
  const removeItemFromLabResult = async (labId, itemIndex) => {
    const lab = labResults.find(l => l.id === labId);
    if (!lab) return;

    const updatedData = lab.data.filter((_, idx) => idx !== itemIndex);

    try {
      await updateDoc(
        doc(db, 'users', user.uid, 'patients', patient.id, 'labResults', labId),
        { data: updatedData }
      );
    } catch (err) {
      console.error('Error removing item from lab result:', err);
    }
  };

  const saveMemo = async () => {
    try {
      await updateDoc(doc(db, 'users', user.uid, 'patients', patient.id), {
        memo: memoText
      });
      setEditingMemo(false);
    } catch (err) {
      console.error('Error updating memo:', err);
    }
  };

  const savePatientInfo = async () => {
    try {
      await updateDoc(doc(db, 'users', user.uid, 'patients', patient.id), {
        diagnosis: editedPatient.diagnosis,
        group: editedPatient.group,
        onsetDate: editedPatient.onsetDate,
      });
      // 親コンポーネントの患者データも更新されるようにonBackを呼ぶか、
      // またはpatientオブジェクトを直接更新
      patient.diagnosis = editedPatient.diagnosis;
      patient.group = editedPatient.group;
      patient.onsetDate = editedPatient.onsetDate;
      setEditingPatientInfo(false);
    } catch (err) {
      console.error('Error updating patient info:', err);
      alert('患者情報の更新に失敗しました');
    }
  };

  // 患者ID保存（重複チェック付き）
  const saveDisplayId = async () => {
    const trimmedId = newDisplayId.trim();

    // 空チェック
    if (!trimmedId) {
      setDisplayIdError('IDを入力してください');
      return;
    }

    // 変更なしの場合
    if (trimmedId === patient.displayId) {
      setEditingDisplayId(false);
      setDisplayIdError('');
      return;
    }

    try {
      // 重複チェック: 同じユーザーの他の患者で同じIDが使われていないか確認
      const patientsRef = collection(db, 'users', user.uid, 'patients');
      const snapshot = await getDocs(patientsRef);
      const isDuplicate = snapshot.docs.some(doc =>
        doc.id !== patient.id && doc.data().displayId === trimmedId
      );

      if (isDuplicate) {
        setDisplayIdError(`ID "${trimmedId}" は既に使用されています`);
        return;
      }

      // 更新実行
      await updateDoc(doc(db, 'users', user.uid, 'patients', patient.id), {
        displayId: trimmedId,
      });

      // ローカルのpatientオブジェクトも更新
      patient.displayId = trimmedId;
      setEditingDisplayId(false);
      setDisplayIdError('');
    } catch (err) {
      console.error('Error updating displayId:', err);
      setDisplayIdError('IDの更新に失敗しました');
    }
  };

  return (
    <div style={styles.mainContainer}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <button onClick={onBack} style={styles.backButton}>
            ← 戻る
          </button>
          {editingDisplayId ? (
            <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
              <input
                type="text"
                value={newDisplayId}
                onChange={(e) => {
                  setNewDisplayId(e.target.value);
                  setDisplayIdError('');
                }}
                style={{
                  padding: '6px 12px',
                  fontSize: '18px',
                  fontWeight: '600',
                  border: displayIdError ? '2px solid #ef4444' : '2px solid #3b82f6',
                  borderRadius: '6px',
                  width: '150px',
                }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveDisplayId();
                  if (e.key === 'Escape') {
                    setEditingDisplayId(false);
                    setNewDisplayId(patient?.displayId || '');
                    setDisplayIdError('');
                  }
                }}
              />
              <button
                onClick={saveDisplayId}
                style={{
                  padding: '6px 12px',
                  background: '#22c55e',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                保存
              </button>
              <button
                onClick={() => {
                  setEditingDisplayId(false);
                  setNewDisplayId(patient?.displayId || '');
                  setDisplayIdError('');
                }}
                style={{
                  padding: '6px 12px',
                  background: '#6b7280',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                キャンセル
              </button>
              {displayIdError && (
                <span style={{color: '#ef4444', fontSize: '13px'}}>{displayIdError}</span>
              )}
            </div>
          ) : (
            <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
              <h1 style={styles.headerTitle}>{patient?.displayId}</h1>
              <button
                onClick={() => {
                  setNewDisplayId(patient?.displayId || '');
                  setEditingDisplayId(true);
                }}
                style={{
                  padding: '4px 8px',
                  background: 'transparent',
                  color: '#6b7280',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px',
                }}
                title="IDを編集"
              >
                ID編集
              </button>
            </div>
          )}
          <span style={styles.diagnosisBadge}>{patient?.diagnosis}</span>
        </div>
        <div style={{display: 'flex', gap: '10px'}}>
          <button
            onClick={() => setShowClinicalTimeline(true)}
            style={{
              padding: '8px 16px',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            📊 臨床経過タイムライン
          </button>
        </div>
      </header>

      <main style={styles.detailContent}>
        {/* 基本情報セクション */}
        <section style={styles.section}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>基本情報</h2>
            <button
              onClick={() => {
                if (editingPatientInfo) {
                  // キャンセル時は元の値に戻す
                  setEditedPatient({
                    diagnosis: patient?.diagnosis || '',
                    group: patient?.group || '',
                    onsetDate: patient?.onsetDate || '',
                  });
                }
                setEditingPatientInfo(!editingPatientInfo);
              }}
              style={styles.editButton}
            >
              {editingPatientInfo ? 'キャンセル' : '編集'}
            </button>
          </div>

          {editingPatientInfo ? (
            <div style={styles.infoGrid}>
              <div style={styles.infoItem}>
                <span style={styles.infoLabel}>診断名</span>
                <input
                  type="text"
                  value={editedPatient.diagnosis}
                  onChange={(e) => setEditedPatient({...editedPatient, diagnosis: e.target.value})}
                  style={{...styles.input, marginTop: '4px'}}
                />
              </div>
              <div style={styles.infoItem}>
                <span style={styles.infoLabel}>群</span>
                <input
                  type="text"
                  value={editedPatient.group}
                  onChange={(e) => setEditedPatient({...editedPatient, group: e.target.value})}
                  style={{...styles.input, marginTop: '4px'}}
                  placeholder="例: 急性期群"
                />
              </div>
              <div style={styles.infoItem}>
                <span style={styles.infoLabel}>発症日</span>
                <input
                  type="date"
                  value={editedPatient.onsetDate}
                  onChange={(e) => setEditedPatient({...editedPatient, onsetDate: e.target.value})}
                  style={{...styles.input, marginTop: '4px'}}
                />
              </div>
              <div style={styles.infoItem}>
                <span style={styles.infoLabel}>登録日</span>
                <span style={styles.infoValue}>
                  {patient?.createdAt?.toDate?.()?.toLocaleDateString('ja-JP') || '-'}
                </span>
              </div>
              <div style={{gridColumn: '1 / -1', marginTop: '10px'}}>
                <button onClick={savePatientInfo} style={styles.saveButton}>保存</button>
              </div>
            </div>
          ) : (
            <div style={styles.infoGrid}>
              <div style={styles.infoItem}>
                <span style={styles.infoLabel}>診断名</span>
                <span style={styles.infoValue}>{patient?.diagnosis || '未設定'}</span>
              </div>
              <div style={styles.infoItem}>
                <span style={styles.infoLabel}>群</span>
                <span style={styles.infoValue}>{patient?.group || '未設定'}</span>
              </div>
              <div style={styles.infoItem}>
                <span style={styles.infoLabel}>発症日</span>
                <span style={styles.infoValue}>{patient?.onsetDate || '未設定'}</span>
              </div>
              <div style={styles.infoItem}>
                <span style={styles.infoLabel}>登録日</span>
                <span style={styles.infoValue}>
                  {patient?.createdAt?.toDate?.()?.toLocaleDateString('ja-JP') || '-'}
                </span>
              </div>
            </div>
          )}

          <div style={styles.memoSection}>
            <div style={styles.memoHeader}>
              <span style={styles.infoLabel}>メモ</span>
              <button
                onClick={() => setEditingMemo(!editingMemo)}
                style={styles.editButton}
              >
                {editingMemo ? 'キャンセル' : '編集'}
              </button>
            </div>
            {editingMemo ? (
              <div>
                <textarea
                  value={memoText}
                  onChange={(e) => setMemoText(e.target.value)}
                  style={{...styles.input, minHeight: '100px', width: '100%', boxSizing: 'border-box'}}
                />
                <button onClick={saveMemo} style={styles.saveButton}>保存</button>
              </div>
            ) : (
              <p style={styles.memoText}>{patient?.memo || 'メモなし'}</p>
            )}
          </div>
        </section>

        {/* 臨床経過セクション（治療薬と臨床イベントを統合） */}
        <section style={styles.section}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>臨床経過</h2>
            <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
              <button
                onClick={openAddTreatmentModal}
                style={{...styles.addLabButton, background: '#ecfdf5', color: '#047857'}}
              >
                <span>💊</span> 治療薬追加
              </button>
              <button
                onClick={openAddEventModal}
                style={{...styles.addLabButton, background: '#fef3c7', color: '#92400e'}}
              >
                <span>📋</span> 症状追加
              </button>
              <button
                onClick={exportClinicalEventsCSV}
                style={{...styles.addLabButton, background: '#e0f2fe', color: '#0369a1'}}
              >
                <span>📥</span> CSV出力
              </button>
              <label style={{...styles.addLabButton, background: '#f3e8ff', color: '#7c3aed', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'}}>
                <span>📤</span> CSVインポート
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => {
                    if (e.target.files[0]) {
                      importClinicalEventsCSV(e.target.files[0]);
                      e.target.value = '';
                    }
                  }}
                  style={{display: 'none'}}
                />
              </label>
              <button
                onClick={downloadClinicalEventsSample}
                style={{...styles.addLabButton, background: '#fafafa', color: '#6b7280', border: '1px dashed #d1d5db'}}
              >
                <span>📄</span> サンプルCSV
              </button>
            </div>
          </div>

          {clinicalEvents.length === 0 && treatments.length === 0 ? (
            <div style={styles.emptyLab}>
              <p>臨床経過データはまだありません</p>
              <p style={{fontSize: '13px', marginTop: '8px'}}>
                治療薬や症状（意識障害、てんかん発作、不随意運動など）の経過を記録できます
              </p>
            </div>
          ) : (
            <>
              {/* 臨床経過タイムライン（同一症状をまとめて表示・重症度の階段状変化） */}
              {(() => {
                // 発症日がない場合はスキップ
                if (!patient.onsetDate) return null;

                // 同じイベントタイプでグループ化
                const eventGroups = {};
                clinicalEvents.forEach(e => {
                  const type = e.eventType;
                  if (!eventGroups[type]) {
                    eventGroups[type] = {
                      type: type,
                      inputType: e.inputType,
                      entries: []
                    };
                  }
                  eventGroups[type].entries.push(e);
                });

                // 各グループ内でソート
                Object.values(eventGroups).forEach(group => {
                  group.entries.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                });

                const groupList = Object.values(eventGroups).sort((a, b) => {
                  const aFirst = a.entries[0]?.startDate || '';
                  const bFirst = b.entries[0]?.startDate || '';
                  return new Date(aFirst) - new Date(bFirst);
                });

                // タイムラインの範囲を計算
                const allDays = clinicalEvents.flatMap(e => {
                  const start = calcDaysFromOnset(e.startDate);
                  const end = e.endDate ? calcDaysFromOnset(e.endDate) : start;
                  return [start, end];
                }).filter(d => d !== null);

                if (allDays.length === 0) return null;

                const minDay = Math.min(...allDays, 0);
                const maxDay = Math.max(...allDays) + 3;
                const dayRange = maxDay - minDay || 1;

                // 症状タイプごとの色
                const eventColors = {
                  '意識障害': '#dc2626',
                  'てんかん発作': '#ea580c',
                  '不随意運動': '#d97706',
                  '麻痺': '#ca8a04',
                  '感覚障害': '#65a30d',
                  '失語': '#16a34a',
                  '認知機能障害': '#0d9488',
                  '精神症状': '#0891b2',
                  '発熱': '#ef4444',
                  '頭痛': '#f97316',
                  '髄膜刺激症状': '#84cc16',
                  '人工呼吸器管理': '#7c3aed',
                  'ICU入室': '#9333ea'
                };

                // 重症度スコア（高さ計算用）
                const getSeverityScore = (event) => {
                  if (event.jcs) {
                    // JCSスコアを数値化
                    if (event.jcs === '0') return 0;
                    if (event.jcs.startsWith('I-')) return parseInt(event.jcs.split('-')[1]) || 1;
                    if (event.jcs.startsWith('II-')) return 10 + (parseInt(event.jcs.split('-')[1]) || 10);
                    if (event.jcs.startsWith('III-')) return 100 + (parseInt(event.jcs.split('-')[1]) || 100);
                    return 1;
                  }
                  if (event.frequency) {
                    const freqScores = { hourly: 6, several_daily: 5, daily: 4, several_weekly: 3, weekly: 2, monthly: 1, rare: 0.5 };
                    return freqScores[event.frequency] || 1;
                  }
                  if (event.severity) {
                    const sevScores = { '重症': 3, '中等症': 2, '軽症': 1 };
                    return sevScores[event.severity] || 1;
                  }
                  if (event.presence) {
                    return event.presence === 'あり' ? 1 : 0;
                  }
                  return 1;
                };

                // グループ内の最大スコア
                const getMaxScore = (entries) => {
                  const scores = entries.map(e => getSeverityScore(e)).filter(s => s > 0);
                  return scores.length > 0 ? Math.max(...scores) : 1;
                };

                // 詳細ラベル取得
                const getDetailLabel = (event) => {
                  if (event.jcs) return `JCS ${event.jcs}`;
                  if (event.frequency) {
                    const freqLabels = { hourly: '毎時間', several_daily: '1日数回', daily: '毎日', several_weekly: '週数回', weekly: '週1回', monthly: '月1回', rare: '稀' };
                    return freqLabels[event.frequency] || event.frequency;
                  }
                  if (event.severity) return event.severity;
                  if (event.presence) return event.presence;
                  return '';
                };

                return (
                  <div style={{
                    marginBottom: '20px',
                    padding: '16px',
                    background: 'white',
                    borderRadius: '12px',
                    border: '1px solid #e5e7eb'
                  }}>
                    <h3 style={{fontSize: '14px', fontWeight: '600', color: '#1f2937', marginBottom: '16px'}}>
                      臨床経過タイムライン（症状推移）
                    </h3>

                    {/* X軸（Day表示）- 経過が長い場合は間隔を自動調整 */}
                    <div style={{marginLeft: '160px', marginBottom: '8px', position: 'relative', height: '20px'}}>
                      {(() => {
                        // 表示間隔を自動調整（ラベルが被らないように）
                        let step = 5;
                        if (dayRange > 50) step = 10;
                        if (dayRange > 100) step = 20;
                        if (dayRange > 200) step = 30;
                        if (dayRange > 500) step = 50;
                        if (dayRange > 1000) step = 100;

                        const labels = [];
                        const firstDay = Math.ceil(minDay / step) * step;
                        for (let day = firstDay; day <= maxDay; day += step) {
                          labels.push(day);
                        }
                        if (labels[0] !== minDay && minDay >= 0) labels.unshift(minDay);

                        return labels.map((day, i) => {
                          const leftPercent = ((day - minDay) / dayRange) * 100;
                          return (
                            <span
                              key={i}
                              style={{
                                position: 'absolute',
                                left: `${leftPercent}%`,
                                transform: 'translateX(-50%)',
                                fontSize: '10px',
                                color: '#6b7280',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              Day {day}
                            </span>
                          );
                        });
                      })()}
                    </div>

                    {/* 症状ごとのタイムライン */}
                    <div style={{display: 'flex', flexDirection: 'column', gap: '12px'}}>
                      {groupList.map((group, gIdx) => {
                        const color = eventColors[group.type] || '#6b7280';
                        const maxScore = getMaxScore(group.entries);
                        const maxBarHeight = 40;

                        // 有無タイプ（presence）は固定高さ
                        const isPresenceType = group.inputType === 'presence';

                        return (
                          <div key={gIdx} style={{display: 'flex', alignItems: 'flex-end', minHeight: `${maxBarHeight + 20}px`}}>
                            {/* 症状名ラベル */}
                            <div style={{
                              width: '160px',
                              flexShrink: 0,
                              fontSize: '11px',
                              color: '#374151',
                              paddingRight: '10px',
                              textAlign: 'right',
                              paddingBottom: '4px'
                            }}>
                              <div style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                background: color + '20',
                                border: `1px solid ${color}`,
                                borderRadius: '4px',
                                padding: '2px 8px',
                                maxWidth: '100%'
                              }}>
                                <span style={{
                                  width: '8px',
                                  height: '8px',
                                  borderRadius: '50%',
                                  background: color,
                                  flexShrink: 0
                                }} />
                                <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                                  {group.type}
                                </span>
                              </div>
                            </div>

                            {/* タイムラインエリア */}
                            <div style={{
                              flex: 1,
                              position: 'relative',
                              height: `${maxBarHeight + 10}px`,
                              background: '#fafafa',
                              borderRadius: '4px',
                              borderBottom: '1px solid #e5e7eb'
                            }}>
                              {group.entries.map((entry, eIdx) => {
                                const startDay = calcDaysFromOnset(entry.startDate);
                                const endDay = entry.endDate ? calcDaysFromOnset(entry.endDate) : startDay;
                                const isSingleDay = startDay === endDay;
                                const score = getSeverityScore(entry);
                                const detailLabel = getDetailLabel(entry);

                                const leftPercent = ((startDay - minDay) / dayRange) * 100;
                                const widthPercent = isSingleDay ? 1.5 : ((endDay - startDay) / dayRange) * 100;

                                // スコアに応じた高さ（階段状）
                                const heightPercent = isPresenceType ? (entry.presence === 'あり' ? 60 : 20) : (score / maxScore) * 100;
                                const barHeight = Math.max((heightPercent / 100) * maxBarHeight, 8);

                                if (isSingleDay) {
                                  // 単発は丸で表示
                                  return (
                                    <div
                                      key={eIdx}
                                      style={{
                                        position: 'absolute',
                                        left: `${leftPercent}%`,
                                        bottom: '0',
                                        transform: 'translateX(-50%)',
                                        width: `${Math.max(barHeight * 0.6, 12)}px`,
                                        height: `${barHeight}px`,
                                        background: color,
                                        borderRadius: '50% 50% 0 0'
                                      }}
                                      title={`${group.type}: Day ${startDay}${detailLabel ? ` (${detailLabel})` : ''}`}
                                    />
                                  );
                                }

                                // 継続症状は階段状のバー
                                return (
                                  <div
                                    key={eIdx}
                                    style={{
                                      position: 'absolute',
                                      left: `${leftPercent}%`,
                                      width: `${Math.max(widthPercent, 0.8)}%`,
                                      height: `${barHeight}px`,
                                      bottom: '0',
                                      background: `linear-gradient(180deg, ${color} 0%, ${color}cc 100%)`,
                                      borderRadius: '4px 4px 0 0',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      overflow: 'visible',
                                      borderLeft: eIdx > 0 ? '1px solid rgba(255,255,255,0.5)' : 'none'
                                    }}
                                    title={`${group.type}: Day ${startDay}${endDay !== startDay ? `〜${endDay}` : ''}${detailLabel ? ` (${detailLabel})` : ''}`}
                                  >
                                    {detailLabel && widthPercent > 5 && (
                                      <span style={{
                                        fontSize: '8px',
                                        color: 'white',
                                        fontWeight: '600',
                                        textShadow: '0 0 2px rgba(0,0,0,0.4)',
                                        whiteSpace: 'nowrap'
                                      }}>
                                        {detailLabel}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* 凡例 */}
                    <div style={{marginTop: '16px', paddingTop: '12px', borderTop: '1px solid #e5e7eb', display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '10px'}}>
                      {Object.entries(eventColors).map(([type, color]) => {
                        const hasType = clinicalEvents.some(e => e.eventType === type);
                        if (!hasType) return null;
                        return (
                          <div key={type} style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                            <div style={{width: '10px', height: '10px', borderRadius: '50%', background: color}} />
                            <span style={{color: '#6b7280'}}>{type}</span>
                          </div>
                        );
                      })}
                      <div style={{color: '#6b7280', marginLeft: '8px'}}>
                        ※ バーの高さ = 重症度/頻度（同一症状内で相対的）
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* 治療タイムライン（臨床経過セクション内） */}
              {(() => {
                if (!patient.onsetDate) return null;
                if (treatments.length === 0) return null;

                // 同じ薬剤名でグループ化
                const medicationGroups = {};
                treatments.forEach(t => {
                  const name = t.medicationName;
                  if (!medicationGroups[name]) {
                    medicationGroups[name] = {
                      name: name,
                      category: t.category,
                      entries: []
                    };
                  }
                  medicationGroups[name].entries.push(t);
                });

                Object.values(medicationGroups).forEach(group => {
                  group.entries.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                });

                const groupList = Object.values(medicationGroups).sort((a, b) => {
                  const aFirst = a.entries[0]?.startDate || '';
                  const bFirst = b.entries[0]?.startDate || '';
                  return new Date(aFirst) - new Date(bFirst);
                });

                // タイムラインの範囲を計算（臨床経過と合わせる）
                const allEventDays = clinicalEvents.flatMap(e => {
                  const start = calcDaysFromOnset(e.startDate);
                  const end = e.endDate ? calcDaysFromOnset(e.endDate) : start;
                  return [start, end];
                }).filter(d => d !== null);

                const allTreatmentDays = treatments.flatMap(t => {
                  const start = calcDaysFromOnset(t.startDate);
                  const end = t.endDate ? calcDaysFromOnset(t.endDate) : start;
                  return [start, end];
                }).filter(d => d !== null);

                const allDays = [...allEventDays, ...allTreatmentDays];
                if (allDays.length === 0) return null;

                const minDay = Math.min(...allDays, 0);
                const maxDay = Math.max(...allDays) + 3;
                const dayRange = maxDay - minDay || 1;

                const categoryColors = {
                  '抗てんかん薬': '#f59e0b',
                  'ステロイド': '#ec4899',
                  '免疫グロブリン': '#3b82f6',
                  '血漿交換': '#6366f1',
                  '免疫抑制剤': '#8b5cf6',
                  '抗ウイルス薬': '#14b8a6',
                  '抗菌薬': '#eab308',
                  '抗浮腫薬': '#0ea5e9',
                  'その他': '#6b7280'
                };

                const getMaxDosage = (entries) => {
                  const dosages = entries.map(e => parseFloat(e.dosage) || 0).filter(d => d > 0);
                  return dosages.length > 0 ? Math.max(...dosages) : 1;
                };

                return (
                  <div style={{
                    marginTop: '20px',
                    padding: '16px',
                    background: 'white',
                    borderRadius: '12px',
                    border: '1px solid #e5e7eb'
                  }}>
                    <h3 style={{fontSize: '14px', fontWeight: '600', color: '#1f2937', marginBottom: '16px'}}>
                      治療タイムライン（投与量推移）
                    </h3>

                    {/* X軸（Day表示）- 経過が長い場合は間隔を自動調整 */}
                    <div style={{marginLeft: '160px', marginBottom: '8px', position: 'relative', height: '20px'}}>
                      {(() => {
                        // 表示間隔を自動調整（ラベルが被らないように）
                        let step = 5;
                        if (dayRange > 50) step = 10;
                        if (dayRange > 100) step = 20;
                        if (dayRange > 200) step = 30;
                        if (dayRange > 500) step = 50;
                        if (dayRange > 1000) step = 100;

                        const labels = [];
                        const firstDay = Math.ceil(minDay / step) * step;
                        for (let day = firstDay; day <= maxDay; day += step) {
                          labels.push(day);
                        }
                        if (labels[0] !== minDay && minDay >= 0) labels.unshift(minDay);

                        return labels.map((day, i) => {
                          const leftPercent = ((day - minDay) / dayRange) * 100;
                          return (
                            <span
                              key={i}
                              style={{
                                position: 'absolute',
                                left: `${leftPercent}%`,
                                transform: 'translateX(-50%)',
                                fontSize: '10px',
                                color: '#6b7280',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              Day {day}
                            </span>
                          );
                        });
                      })()}
                    </div>

                    {/* 薬剤ごとのタイムライン */}
                    <div style={{display: 'flex', flexDirection: 'column', gap: '12px'}}>
                      {groupList.map((group, gIdx) => {
                        const color = categoryColors[group.category] || categoryColors['その他'];
                        const maxDosage = getMaxDosage(group.entries);
                        const maxBarHeight = 40;

                        const allSingleDay = group.entries.every(e => {
                          const start = calcDaysFromOnset(e.startDate);
                          const end = e.endDate ? calcDaysFromOnset(e.endDate) : start;
                          return start === end;
                        });

                        return (
                          <div key={gIdx} style={{display: 'flex', alignItems: 'flex-end', minHeight: `${maxBarHeight + 20}px`}}>
                            <div style={{
                              width: '160px',
                              flexShrink: 0,
                              fontSize: '11px',
                              color: '#374151',
                              paddingRight: '10px',
                              textAlign: 'right',
                              paddingBottom: '4px'
                            }}>
                              <div style={{
                                display: 'inline-block',
                                background: color + '20',
                                border: `1px solid ${color}`,
                                borderRadius: '4px',
                                padding: '2px 6px',
                                maxWidth: '100%',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }} title={group.name}>
                                {group.name}
                              </div>
                            </div>

                            <div style={{
                              flex: 1,
                              position: 'relative',
                              height: `${maxBarHeight + 10}px`,
                              background: '#fafafa',
                              borderRadius: '4px',
                              borderBottom: '1px solid #e5e7eb'
                            }}>
                              {group.entries.map((entry, eIdx) => {
                                const startDay = calcDaysFromOnset(entry.startDate);
                                const endDay = entry.endDate ? calcDaysFromOnset(entry.endDate) : startDay;
                                const isSingleDay = startDay === endDay;
                                const dosage = parseFloat(entry.dosage) || 0;

                                const leftPercent = ((startDay - minDay) / dayRange) * 100;
                                const widthPercent = isSingleDay ? 1.5 : ((endDay - startDay) / dayRange) * 100;
                                const heightPercent = dosage > 0 ? (dosage / maxDosage) * 100 : 50;
                                const barHeight = Math.max((heightPercent / 100) * maxBarHeight, 8);

                                if (isSingleDay && allSingleDay) {
                                  return (
                                    <div
                                      key={eIdx}
                                      style={{
                                        position: 'absolute',
                                        left: `${leftPercent}%`,
                                        bottom: '0',
                                        transform: 'translateX(-50%)',
                                        width: 0,
                                        height: 0,
                                        borderLeft: '10px solid transparent',
                                        borderRight: '10px solid transparent',
                                        borderBottom: `${barHeight}px solid ${color}`
                                      }}
                                      title={`${group.name}: Day ${startDay}${dosage ? ` (${entry.dosage}${entry.dosageUnit || ''})` : ''}`}
                                    />
                                  );
                                }

                                return (
                                  <div
                                    key={eIdx}
                                    style={{
                                      position: 'absolute',
                                      left: `${leftPercent}%`,
                                      width: `${Math.max(widthPercent, 0.8)}%`,
                                      height: `${barHeight}px`,
                                      bottom: '0',
                                      background: color,
                                      borderRadius: '2px 2px 0 0',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      overflow: 'visible',
                                      borderLeft: eIdx > 0 ? '1px solid rgba(255,255,255,0.5)' : 'none'
                                    }}
                                    title={`${group.name}: Day ${startDay}${endDay !== startDay ? `〜${endDay}` : ''}${dosage ? ` (${entry.dosage}${entry.dosageUnit || ''})` : ''}`}
                                  >
                                    {dosage > 0 && widthPercent > 4 && (
                                      <span style={{
                                        fontSize: '9px',
                                        color: 'white',
                                        fontWeight: '600',
                                        textShadow: '0 0 2px rgba(0,0,0,0.4)',
                                        whiteSpace: 'nowrap'
                                      }}>
                                        {entry.dosage}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* 凡例 */}
                    <div style={{marginTop: '16px', paddingTop: '12px', borderTop: '1px solid #e5e7eb', display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '10px'}}>
                      {Object.entries(categoryColors).map(([cat, color]) => {
                        const hasCat = treatments.some(t => t.category === cat);
                        if (!hasCat) return null;
                        return (
                          <div key={cat} style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                            <div style={{width: '14px', height: '14px', background: color, borderRadius: '2px'}} />
                            <span style={{color: '#6b7280'}}>{cat}</span>
                          </div>
                        );
                      })}
                      <div style={{color: '#6b7280', marginLeft: '8px'}}>
                        ※ バーの高さ = 投与量（同一薬剤内で相対的）
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* イベント一覧（編集用） */}
              <div style={{display: 'flex', flexDirection: 'column', gap: '10px'}}>
                {clinicalEvents.map((event) => {
                  const startDay = calcDaysFromOnset(event.startDate);
                  const endDay = event.endDate ? calcDaysFromOnset(event.endDate) : null;
                  const isEditing = editingEventId === event.id;
                  const config = eventTypeConfig[event.eventType] || { inputType: 'severity' };

                  // 編集モード
                  if (isEditing) {
                    return (
                      <div
                        key={event.id}
                        style={{
                          background: '#fefce8',
                          border: '2px solid #facc15',
                          borderRadius: '10px',
                          padding: '16px'
                        }}
                      >
                        <div style={{marginBottom: '12px', fontWeight: '600', color: '#a16207', fontSize: '14px'}}>
                          編集中: {event.eventType}
                        </div>
                        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px'}}>
                          <div>
                            <label style={{fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px'}}>開始日</label>
                            <input
                              type="date"
                              value={editEvent.startDate}
                              onChange={(e) => setEditEvent({...editEvent, startDate: e.target.value})}
                              style={{...styles.input, width: '100%', padding: '8px'}}
                            />
                          </div>
                          <div>
                            <label style={{fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px'}}>終了日</label>
                            <input
                              type="date"
                              value={editEvent.endDate}
                              onChange={(e) => setEditEvent({...editEvent, endDate: e.target.value})}
                              style={{...styles.input, width: '100%', padding: '8px'}}
                            />
                          </div>
                        </div>

                        {/* JCS入力 */}
                        {config.inputType === 'jcs' && (
                          <div style={{marginTop: '10px'}}>
                            <label style={{fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px'}}>JCSスケール</label>
                            <select
                              value={editEvent.jcs}
                              onChange={(e) => setEditEvent({...editEvent, jcs: e.target.value})}
                              style={{...styles.input, width: '100%', padding: '8px'}}
                            >
                              <option value="">選択</option>
                              {jcsOptions.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>
                        )}

                        {/* 頻度入力 */}
                        {config.inputType === 'frequency' && (
                          <div style={{marginTop: '10px'}}>
                            <label style={{fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px'}}>頻度</label>
                            <select
                              value={editEvent.frequency}
                              onChange={(e) => setEditEvent({...editEvent, frequency: e.target.value})}
                              style={{...styles.input, width: '100%', padding: '8px'}}
                            >
                              <option value="">選択</option>
                              {frequencyOptions.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>
                        )}

                        {/* 有無入力 */}
                        {config.inputType === 'presence' && (
                          <div style={{marginTop: '10px'}}>
                            <label style={{fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px'}}>有無</label>
                            <select
                              value={editEvent.presence}
                              onChange={(e) => setEditEvent({...editEvent, presence: e.target.value})}
                              style={{...styles.input, width: '100%', padding: '8px'}}
                            >
                              <option value="">選択</option>
                              <option value="あり">あり</option>
                              <option value="なし">なし</option>
                            </select>
                          </div>
                        )}

                        {/* 重症度入力 */}
                        {config.inputType === 'severity' && (
                          <div style={{marginTop: '10px'}}>
                            <label style={{fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px'}}>重症度</label>
                            <select
                              value={editEvent.severity}
                              onChange={(e) => setEditEvent({...editEvent, severity: e.target.value})}
                              style={{...styles.input, width: '100%', padding: '8px'}}
                            >
                              <option value="">選択</option>
                              <option value="軽症">軽症</option>
                              <option value="中等症">中等症</option>
                              <option value="重症">重症</option>
                            </select>
                          </div>
                        )}

                        <div style={{marginTop: '10px'}}>
                          <label style={{fontSize: '11px', color: '#6b7280', display: 'block', marginBottom: '4px'}}>メモ</label>
                          <input
                            type="text"
                            value={editEvent.note}
                            onChange={(e) => setEditEvent({...editEvent, note: e.target.value})}
                            style={{...styles.input, width: '100%', padding: '8px'}}
                            placeholder="メモ"
                          />
                        </div>

                        <div style={{display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end'}}>
                          <button
                            onClick={cancelEditEvent}
                            style={{
                              padding: '6px 14px',
                              background: '#f3f4f6',
                              border: '1px solid #d1d5db',
                              borderRadius: '6px',
                              cursor: 'pointer',
                              fontSize: '13px'
                            }}
                          >
                            キャンセル
                          </button>
                          <button
                            onClick={updateClinicalEvent}
                            style={{
                              padding: '6px 14px',
                              background: '#f59e0b',
                              color: 'white',
                              border: 'none',
                              borderRadius: '6px',
                              cursor: 'pointer',
                              fontSize: '13px',
                              fontWeight: '500'
                            }}
                          >
                            保存
                          </button>
                        </div>
                      </div>
                    );
                  }

                  // 通常表示モード
                  return (
                    <div
                      key={event.id}
                      style={{
                        background: '#fffbeb',
                        border: '1px solid #fcd34d',
                        borderRadius: '10px',
                        padding: '14px 16px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start'
                      }}
                    >
                      <div style={{flex: 1}}>
                        <div style={{display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px', flexWrap: 'wrap'}}>
                          <span style={{
                            fontWeight: '600',
                            color: '#92400e',
                            fontSize: '14px'
                          }}>
                            {event.eventType}
                          </span>
                          {/* JCS表示 */}
                          {event.jcs && (
                            <span style={{
                              fontSize: '11px',
                              background: event.jcs.startsWith('III') ? '#fecaca' : event.jcs.startsWith('II') ? '#fed7aa' : event.jcs.startsWith('I-') ? '#fef3c7' : '#d9f99d',
                              color: event.jcs.startsWith('III') ? '#dc2626' : event.jcs.startsWith('II') ? '#ea580c' : event.jcs.startsWith('I-') ? '#d97706' : '#65a30d',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontWeight: '500'
                            }}>
                              JCS {event.jcs}
                            </span>
                          )}
                          {/* 頻度表示 */}
                          {event.frequency && (
                            <span style={{
                              fontSize: '11px',
                              background: '#dbeafe',
                              color: '#1d4ed8',
                              padding: '2px 8px',
                              borderRadius: '4px'
                            }}>
                              {frequencyOptions.find(f => f.value === event.frequency)?.label || event.frequency}
                            </span>
                          )}
                          {/* 有無表示 */}
                          {event.presence && (
                            <span style={{
                              fontSize: '11px',
                              background: event.presence === 'あり' ? '#fee2e2' : '#dcfce7',
                              color: event.presence === 'あり' ? '#dc2626' : '#16a34a',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontWeight: '500'
                            }}>
                              {event.presence}
                            </span>
                          )}
                          {/* 重症度表示 */}
                          {event.severity && (
                            <span style={{
                              fontSize: '11px',
                              background: event.severity === '重症' ? '#fecaca' : event.severity === '中等症' ? '#fed7aa' : '#d9f99d',
                              color: event.severity === '重症' ? '#dc2626' : event.severity === '中等症' ? '#ea580c' : '#65a30d',
                              padding: '2px 8px',
                              borderRadius: '4px'
                            }}>
                              {event.severity}
                            </span>
                          )}
                        </div>
                        <div style={{fontSize: '13px', color: '#78716c'}}>
                          <span>{event.startDate}</span>
                          {startDay !== null && <span style={{color: '#a1a1aa'}}> (Day {startDay})</span>}
                          {event.endDate && (
                            <>
                              <span> 〜 {event.endDate}</span>
                              {endDay !== null && <span style={{color: '#a1a1aa'}}> (Day {endDay})</span>}
                            </>
                          )}
                          {!event.endDate && event.inputType !== 'presence' && <span style={{color: '#ea580c'}}> 〜 継続中</span>}
                        </div>
                        {event.note && (
                          <p style={{fontSize: '12px', color: '#78716c', marginTop: '6px', marginBottom: 0}}>
                            {event.note}
                          </p>
                        )}
                      </div>
                      <div style={{display: 'flex', gap: '4px'}}>
                        <button
                          onClick={() => startEditEvent(event)}
                          title="編集"
                          style={{
                            background: '#fefce8',
                            border: '1px solid #fde047',
                            borderRadius: '4px',
                            color: '#a16207',
                            cursor: 'pointer',
                            padding: '4px 8px',
                            fontSize: '11px'
                          }}
                        >
                          ✏️ 編集
                        </button>
                        <button
                          onClick={() => copyEvent(event)}
                          title="この日付・種類でコピー"
                          style={{
                            background: '#f0f9ff',
                            border: '1px solid #bae6fd',
                            borderRadius: '4px',
                            color: '#0369a1',
                            cursor: 'pointer',
                            padding: '4px 8px',
                            fontSize: '11px'
                          }}
                        >
                          📋 コピー
                        </button>
                        <button
                          onClick={() => deleteClinicalEvent(event.id)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#a1a1aa',
                            cursor: 'pointer',
                            padding: '4px',
                            fontSize: '16px'
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 治療薬一覧（編集・削除用） */}
              {treatments.length > 0 && (
                <div style={{marginTop: '24px'}}>
                  <h4 style={{fontSize: '14px', fontWeight: '600', color: '#047857', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px'}}>
                    <span>💊</span> 治療薬一覧
                  </h4>
                  <div style={{display: 'flex', flexDirection: 'column', gap: '10px'}}>
                    {treatments.map((treatment) => {
                      const startDay = calcDaysFromOnset(treatment.startDate);
                      const endDay = treatment.endDate ? calcDaysFromOnset(treatment.endDate) : null;
                      const isEditing = editingTreatmentId === treatment.id;

                      const categoryColors = {
                        '抗てんかん薬': { bg: '#fef3c7', border: '#fcd34d', text: '#92400e' },
                        'ステロイド': { bg: '#fce7f3', border: '#f9a8d4', text: '#9d174d' },
                        '免疫グロブリン': { bg: '#dbeafe', border: '#93c5fd', text: '#1e40af' },
                        '血漿交換': { bg: '#e0e7ff', border: '#a5b4fc', text: '#3730a3' },
                        '免疫抑制剤': { bg: '#f3e8ff', border: '#c4b5fd', text: '#6b21a8' },
                        '抗ウイルス薬': { bg: '#ccfbf1', border: '#5eead4', text: '#0f766e' },
                        '抗菌薬': { bg: '#fef9c3', border: '#fde047', text: '#a16207' },
                        '抗浮腫薬': { bg: '#e0f2fe', border: '#7dd3fc', text: '#0369a1' },
                        'その他': { bg: '#f3f4f6', border: '#d1d5db', text: '#374151' }
                      };
                      const colors = categoryColors[treatment.category] || categoryColors['その他'];

                      if (isEditing) {
                        return (
                          <div key={treatment.id} style={{background: '#f0fdf4', border: '2px solid #22c55e', borderRadius: '10px', padding: '16px'}}>
                            <div style={{marginBottom: '12px', fontWeight: '600', color: '#166534', fontSize: '14px'}}>編集中: {treatment.medicationName}</div>
                            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px'}}>
                              <div>
                                <label style={{fontSize: '11px', color: '#6b7280'}}>薬剤名</label>
                                <input type="text" value={editTreatment.medicationName} onChange={(e) => setEditTreatment({...editTreatment, medicationName: e.target.value})} style={{...styles.input, width: '100%', padding: '8px'}} />
                              </div>
                              <div>
                                <label style={{fontSize: '11px', color: '#6b7280'}}>カテゴリ</label>
                                <select value={editTreatment.category} onChange={(e) => setEditTreatment({...editTreatment, category: e.target.value})} style={{...styles.input, width: '100%', padding: '8px'}}>
                                  {Object.keys(treatmentCategories).map(cat => (<option key={cat} value={cat}>{cat}</option>))}
                                </select>
                              </div>
                              {!treatmentCategories[editTreatment.category]?.noDosage && (
                                <>
                                  <div>
                                    <label style={{fontSize: '11px', color: '#6b7280'}}>投与量</label>
                                    <input type="text" value={editTreatment.dosage} onChange={(e) => setEditTreatment({...editTreatment, dosage: e.target.value})} style={{...styles.input, width: '100%', padding: '8px'}} />
                                  </div>
                                  <div>
                                    <label style={{fontSize: '11px', color: '#6b7280'}}>単位</label>
                                    <select value={editTreatment.dosageUnit} onChange={(e) => setEditTreatment({...editTreatment, dosageUnit: e.target.value})} style={{...styles.input, width: '100%', padding: '8px'}}>
                                      <option value="">選択</option>
                                      {dosageUnits.map(unit => (<option key={unit} value={unit}>{unit}</option>))}
                                    </select>
                                  </div>
                                </>
                              )}
                              <div>
                                <label style={{fontSize: '11px', color: '#6b7280'}}>開始日</label>
                                <input type="date" value={editTreatment.startDate} onChange={(e) => setEditTreatment({...editTreatment, startDate: e.target.value})} style={{...styles.input, width: '100%', padding: '8px'}} />
                              </div>
                              <div>
                                <label style={{fontSize: '11px', color: '#6b7280'}}>終了日</label>
                                <input type="date" value={editTreatment.endDate} onChange={(e) => setEditTreatment({...editTreatment, endDate: e.target.value})} style={{...styles.input, width: '100%', padding: '8px'}} />
                              </div>
                            </div>
                            <div style={{display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end'}}>
                              <button onClick={cancelEditTreatment} style={{padding: '6px 14px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer'}}>キャンセル</button>
                              <button onClick={updateTreatment} style={{padding: '6px 14px', background: '#22c55e', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: '500'}}>保存</button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={treatment.id} style={{background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start'}}>
                          <div style={{flex: 1}}>
                            <div style={{display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px', flexWrap: 'wrap'}}>
                              <span style={{fontWeight: '600', color: colors.text, fontSize: '14px'}}>{treatment.medicationName}</span>
                              <span style={{fontSize: '11px', background: 'white', color: colors.text, padding: '2px 8px', borderRadius: '4px', border: `1px solid ${colors.border}`}}>{treatment.category}</span>
                            </div>
                            <div style={{display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '12px', color: '#6b7280'}}>
                              <span style={{fontWeight: '600', color: colors.text}}>{treatment.dosage} {treatment.dosageUnit}</span>
                              <span>|</span>
                              <span>{treatment.startDate}{treatment.endDate ? ` 〜 ${treatment.endDate}` : ''}</span>
                              {startDay !== null && (<span style={{color: '#9ca3af'}}>(Day {startDay}{endDay !== null && endDay !== startDay ? `〜${endDay}` : ''})</span>)}
                            </div>
                          </div>
                          <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                            <button onClick={() => startEditTreatment(treatment)} style={{background: '#e0f2fe', border: '1px solid #7dd3fc', borderRadius: '4px', color: '#0369a1', cursor: 'pointer', padding: '4px 8px', fontSize: '11px'}}>✏️ 編集</button>
                            <button onClick={() => deleteTreatment(treatment.id)} style={{background: 'transparent', border: 'none', color: '#a1a1aa', cursor: 'pointer', padding: '4px', fontSize: '16px'}}>×</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* 経時データ分析セクション */}
        <section style={styles.section}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>経時データ分析</h2>
            <button
              onClick={() => setShowTimeSeriesOverlay(!showTimeSeriesOverlay)}
              style={{...styles.addLabButton, background: showTimeSeriesOverlay ? '#bfdbfe' : '#dbeafe', color: '#1d4ed8'}}
            >
              <span>📈</span> {showTimeSeriesOverlay ? '閉じる' : '分析を開く'}
            </button>
          </div>

          {showTimeSeriesOverlay && (
            <div style={{
              background: '#f8fafc',
              borderRadius: '12px',
              padding: '20px',
              border: '1px solid #e2e8f0'
            }}>
              {/* 検査項目選択 */}
              <div style={{marginBottom: '20px'}}>
                <h4 style={{fontSize: '14px', fontWeight: '600', color: '#1e40af', marginBottom: '12px'}}>
                  検査項目を選択
                </h4>
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px',
                  maxHeight: '120px',
                  overflow: 'auto',
                  padding: '8px',
                  background: 'white',
                  borderRadius: '8px',
                  border: '1px solid #e2e8f0'
                }}>
                  {(() => {
                    // labResultsから全項目を抽出
                    const allItems = new Set();
                    labResults.forEach(lab => {
                      lab.data?.forEach(item => allItems.add(item.item));
                    });
                    return Array.from(allItems).sort().map(item => (
                      <label
                        key={item}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '4px 10px',
                          background: selectedLabItemsForChart.includes(item) ? '#dbeafe' : '#f1f5f9',
                          borderRadius: '16px',
                          cursor: 'pointer',
                          fontSize: '12px',
                          border: selectedLabItemsForChart.includes(item) ? '1px solid #3b82f6' : '1px solid transparent'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedLabItemsForChart.includes(item)}
                          onChange={() => {
                            setSelectedLabItemsForChart(prev =>
                              prev.includes(item)
                                ? prev.filter(i => i !== item)
                                : [...prev, item]
                            );
                          }}
                          style={{display: 'none'}}
                        />
                        {item}
                      </label>
                    ));
                  })()}
                  {labResults.length === 0 && (
                    <span style={{color: '#6b7280', fontSize: '12px'}}>検査データがありません</span>
                  )}
                </div>
              </div>

              {/* 治療薬選択 */}
              <div style={{marginBottom: '20px'}}>
                <div style={{display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px'}}>
                  <label style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer'}}>
                    <input
                      type="checkbox"
                      checked={showTreatmentsOnChart}
                      onChange={(e) => setShowTreatmentsOnChart(e.target.checked)}
                    />
                    <span style={{fontSize: '14px', fontWeight: '600', color: '#047857'}}>治療薬を表示</span>
                  </label>
                </div>
                {showTreatmentsOnChart && treatments.length > 0 && (
                  <div style={{
                    padding: '8px',
                    background: 'white',
                    borderRadius: '8px',
                    border: '1px solid #d1fae5'
                  }}>
                    {/* 一括選択ボタン */}
                    <div style={{display: 'flex', gap: '8px', marginBottom: '8px'}}>
                      <button
                        onClick={() => {
                          const allMeds = [...new Set(treatments.map(t => t.medicationName))];
                          setSelectedTreatmentsForChart(allMeds);
                        }}
                        style={{
                          padding: '4px 10px',
                          fontSize: '11px',
                          background: '#d1fae5',
                          border: '1px solid #10b981',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          color: '#065f46'
                        }}
                      >
                        全て選択
                      </button>
                      <button
                        onClick={() => setSelectedTreatmentsForChart([])}
                        style={{
                          padding: '4px 10px',
                          fontSize: '11px',
                          background: '#f1f5f9',
                          border: '1px solid #cbd5e1',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          color: '#64748b'
                        }}
                      >
                        全て解除
                      </button>
                    </div>
                    <div style={{display: 'flex', flexWrap: 'wrap', gap: '8px'}}>
                      {(() => {
                        const allMeds = [...new Set(treatments.map(t => t.medicationName))];
                        return allMeds.map(med => (
                          <label
                            key={med}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 10px',
                              background: selectedTreatmentsForChart.includes(med) ? '#d1fae5' : '#f1f5f9',
                              borderRadius: '16px',
                              cursor: 'pointer',
                              fontSize: '12px',
                              border: selectedTreatmentsForChart.includes(med) ? '1px solid #10b981' : '1px solid transparent'
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedTreatmentsForChart.includes(med)}
                              onChange={() => {
                                setSelectedTreatmentsForChart(prev =>
                                  prev.includes(med)
                                    ? prev.filter(m => m !== med)
                                    : [...prev, med]
                                );
                              }}
                              style={{display: 'none'}}
                            />
                            {med}
                          </label>
                        ));
                      })()}
                    </div>
                  </div>
                )}
              </div>

              {/* 臨床経過選択 */}
              <div style={{marginBottom: '20px'}}>
                <div style={{display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px'}}>
                  <label style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer'}}>
                    <input
                      type="checkbox"
                      checked={showEventsOnChart}
                      onChange={(e) => setShowEventsOnChart(e.target.checked)}
                    />
                    <span style={{fontSize: '14px', fontWeight: '600', color: '#b45309'}}>臨床経過を表示</span>
                  </label>
                </div>
                {showEventsOnChart && clinicalEvents.length > 0 && (
                  <div style={{
                    padding: '8px',
                    background: 'white',
                    borderRadius: '8px',
                    border: '1px solid #fde68a'
                  }}>
                    {/* 一括選択ボタン */}
                    <div style={{display: 'flex', gap: '8px', marginBottom: '8px'}}>
                      <button
                        onClick={() => {
                          const allEventTypes = [...new Set(clinicalEvents.map(e => e.eventType))];
                          setSelectedEventsForChart(allEventTypes);
                        }}
                        style={{
                          padding: '4px 10px',
                          fontSize: '11px',
                          background: '#fef3c7',
                          border: '1px solid #f59e0b',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          color: '#92400e'
                        }}
                      >
                        全て選択
                      </button>
                      <button
                        onClick={() => setSelectedEventsForChart([])}
                        style={{
                          padding: '4px 10px',
                          fontSize: '11px',
                          background: '#f1f5f9',
                          border: '1px solid #cbd5e1',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          color: '#64748b'
                        }}
                      >
                        全て解除
                      </button>
                    </div>
                    <div style={{display: 'flex', flexWrap: 'wrap', gap: '8px'}}>
                      {(() => {
                        const allEventTypes = [...new Set(clinicalEvents.map(e => e.eventType))];
                        return allEventTypes.map(eventType => (
                          <label
                            key={eventType}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 10px',
                              background: selectedEventsForChart.includes(eventType) ? '#fef3c7' : '#f1f5f9',
                              borderRadius: '16px',
                              cursor: 'pointer',
                              fontSize: '12px',
                              border: selectedEventsForChart.includes(eventType) ? '1px solid #f59e0b' : '1px solid transparent'
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedEventsForChart.includes(eventType)}
                              onChange={() => {
                                setSelectedEventsForChart(prev =>
                                  prev.includes(eventType)
                                    ? prev.filter(et => et !== eventType)
                                    : [...prev, eventType]
                                );
                              }}
                              style={{display: 'none'}}
                            />
                            {eventType}
                          </label>
                        ));
                      })()}
                    </div>
                  </div>
                )}
              </div>

              {/* 表示オプション */}
              {(showTreatmentsOnChart || showEventsOnChart) && (
                <div style={{
                  marginBottom: '20px',
                  padding: '12px',
                  background: '#f0f9ff',
                  borderRadius: '8px',
                  border: '1px solid #bae6fd'
                }}>
                  <div style={{display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'center'}}>
                    <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                      <span style={{fontSize: '13px', fontWeight: '500', color: '#0369a1'}}>表示方法:</span>
                      <label style={{display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer'}}>
                        <input
                          type="radio"
                          name="displayMode"
                          checked={timelineDisplayMode === 'separate'}
                          onChange={() => setTimelineDisplayMode('separate')}
                        />
                        <span style={{fontSize: '13px'}}>分離表示</span>
                      </label>
                      <label style={{display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer'}}>
                        <input
                          type="radio"
                          name="displayMode"
                          checked={timelineDisplayMode === 'overlay'}
                          onChange={() => setTimelineDisplayMode('overlay')}
                        />
                        <span style={{fontSize: '13px'}}>重ね表示</span>
                      </label>
                    </div>
                    {timelineDisplayMode === 'separate' && (
                      <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                        <span style={{fontSize: '13px', fontWeight: '500', color: '#0369a1'}}>経過表の位置:</span>
                        <label style={{display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer'}}>
                          <input
                            type="radio"
                            name="timelinePosition"
                            checked={timelinePosition === 'above'}
                            onChange={() => setTimelinePosition('above')}
                          />
                          <span style={{fontSize: '13px'}}>グラフの上</span>
                        </label>
                        <label style={{display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer'}}>
                          <input
                            type="radio"
                            name="timelinePosition"
                            checked={timelinePosition === 'below'}
                            onChange={() => setTimelinePosition('below')}
                          />
                          <span style={{fontSize: '13px'}}>グラフの下</span>
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* チャート表示 */}
              {(selectedLabItemsForChart.length > 0 ||
                (showTreatmentsOnChart && selectedTreatmentsForChart.length > 0) ||
                (showEventsOnChart && selectedEventsForChart.length > 0)) && patient.onsetDate && (
                <div
                  id="clinical-course-container"
                  style={{
                    background: 'white',
                    padding: '20px',
                    borderRadius: '12px',
                    border: '1px solid #e2e8f0'
                  }}
                >
                  {(() => {
                    const labColors = ['#8B0000', '#000080', '#006400', '#B8860B', '#800080', '#008B8B', '#FF4500', '#2F4F4F'];
                    const treatmentBarColors = {
                      '抗てんかん薬': { bg: '#FFF3CD', border: '#FFC107' },
                      'ステロイド': { bg: '#D4EDDA', border: '#28A745' },
                      '免疫グロブリン': { bg: '#CCE5FF', border: '#007BFF' },
                      '血漿交換': { bg: '#E2D5F1', border: '#6F42C1' },
                      '免疫抑制剤': { bg: '#F8D7DA', border: '#DC3545' },
                      '抗ウイルス薬': { bg: '#D1ECF1', border: '#17A2B8' },
                      '抗菌薬': { bg: '#FFF3CD', border: '#FFC107' },
                      '抗浮腫薬': { bg: '#E2E3E5', border: '#6C757D' },
                      'その他': { bg: '#F8F9FA', border: '#ADB5BD' }
                    };
                    const eventBarColors = {
                      '意識障害': { bg: '#FFCCCC', border: '#CC0000' },
                      'てんかん発作': { bg: '#FFE5CC', border: '#FF6600' },
                      '不随意運動': { bg: '#FFF0CC', border: '#CC9900' },
                      '麻痺': { bg: '#FFFFCC', border: '#999900' },
                      '感覚障害': { bg: '#E5FFCC', border: '#669900' },
                      '失語': { bg: '#CCFFCC', border: '#009900' },
                      '認知機能障害': { bg: '#CCFFE5', border: '#009966' },
                      '精神症状': { bg: '#CCF0FF', border: '#0099CC' },
                      '発熱': { bg: '#FFCCCC', border: '#CC0000' },
                      '頭痛': { bg: '#FFE5CC', border: '#FF6600' },
                      '髄膜刺激症状': { bg: '#E5FFCC', border: '#669900' },
                      '人工呼吸器管理': { bg: '#E5CCFF', border: '#6600CC' },
                      'ICU入室': { bg: '#FFCCE5', border: '#CC0066' }
                    };

                    // タイムラインの日数範囲を計算
                    const allDays = [];
                    labResults.forEach(lab => {
                      const day = calcDaysFromOnset(lab.date);
                      if (day !== null) allDays.push(day);
                    });
                    if (showTreatmentsOnChart) {
                      treatments.filter(t => selectedTreatmentsForChart.includes(t.medicationName)).forEach(t => {
                        const start = calcDaysFromOnset(t.startDate);
                        const end = t.endDate ? calcDaysFromOnset(t.endDate) : start;
                        if (start !== null) allDays.push(start, end);
                      });
                    }
                    if (showEventsOnChart) {
                      clinicalEvents.filter(e => selectedEventsForChart.includes(e.eventType)).forEach(e => {
                        const start = calcDaysFromOnset(e.startDate);
                        const end = e.endDate ? calcDaysFromOnset(e.endDate) : start;
                        if (start !== null) allDays.push(start, end);
                      });
                    }

                    if (allDays.length === 0) {
                      return (
                        <div style={{textAlign: 'center', padding: '40px', color: '#6b7280'}}>
                          表示するデータがありません。発症日が設定されていることを確認してください。
                        </div>
                      );
                    }

                    const minDay = Math.min(...allDays, 0);
                    const maxDay = Math.max(...allDays) + 3;
                    const dayRange = maxDay - minDay || 1;

                    // 重症度スコア計算関数
                    const getSeverityScore = (event) => {
                      if (event.jcs) {
                        if (event.jcs === '0') return 0;
                        if (event.jcs.startsWith('I-')) return parseInt(event.jcs.split('-')[1]) || 1;
                        if (event.jcs.startsWith('II-')) return 10 + (parseInt(event.jcs.split('-')[1]) / 10 || 1);
                        if (event.jcs.startsWith('III-')) return 20 + (parseInt(event.jcs.split('-')[1]) / 100 || 1);
                        return 1;
                      }
                      if (event.frequency) {
                        const freqScores = { hourly: 10, several_daily: 8, daily: 6, several_weekly: 4, weekly: 2, monthly: 1, rare: 0.5 };
                        return freqScores[event.frequency] || 1;
                      }
                      if (event.severity) {
                        const sevScores = { '重症': 3, '中等症': 2, '軽症': 1 };
                        return sevScores[event.severity] || 1;
                      }
                      if (event.presence) {
                        return event.presence === 'あり' ? 1 : 0;
                      }
                      return 1;
                    };

                    // CSV出力用データ生成関数
                    const generateTimelineCSV = () => {
                      const rows = [];
                      rows.push(['臨床経過データ', patient.displayId]);
                      rows.push([]);

                      // 治療薬データ
                      if (showTreatmentsOnChart && selectedTreatmentsForChart.length > 0) {
                        rows.push(['【治療薬】']);
                        rows.push(['薬剤名', '開始Day', '終了Day', '投与量', '単位', '開始日', '終了日']);
                        treatments.filter(t => selectedTreatmentsForChart.includes(t.medicationName)).forEach(t => {
                          const startDay = calcDaysFromOnset(t.startDate);
                          const endDay = t.endDate ? calcDaysFromOnset(t.endDate) : startDay;
                          rows.push([
                            t.medicationName,
                            startDay,
                            endDay,
                            t.dosage || '',
                            t.dosageUnit || '',
                            t.startDate,
                            t.endDate || ''
                          ]);
                        });
                        rows.push([]);
                      }

                      // 臨床経過データ
                      if (showEventsOnChart && selectedEventsForChart.length > 0) {
                        rows.push(['【臨床経過】']);
                        rows.push(['イベント', '開始Day', '終了Day', '詳細', '開始日', '終了日']);
                        clinicalEvents.filter(e => selectedEventsForChart.includes(e.eventType)).forEach(e => {
                          const startDay = calcDaysFromOnset(e.startDate);
                          const endDay = e.endDate ? calcDaysFromOnset(e.endDate) : startDay;
                          let detail = e.jcs || e.frequency || e.severity || e.presence || '';
                          rows.push([
                            e.eventType,
                            startDay,
                            endDay,
                            detail,
                            e.startDate,
                            e.endDate || ''
                          ]);
                        });
                        rows.push([]);
                      }

                      // 検査データ
                      if (selectedLabItemsForChart.length > 0) {
                        rows.push(['【検査データ】']);
                        const header = ['Day', '日付', ...selectedLabItemsForChart];
                        rows.push(header);
                        labResults.sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(lab => {
                          const day = calcDaysFromOnset(lab.date);
                          if (day !== null) {
                            const row = [day, lab.date];
                            selectedLabItemsForChart.forEach(item => {
                              const labItem = lab.data?.find(d => d.item === item);
                              row.push(labItem ? labItem.value : '');
                            });
                            rows.push(row);
                          }
                        });
                      }

                      return rows;
                    };

                    // CSVダウンロード
                    const downloadCSV = () => {
                      const rows = generateTimelineCSV();
                      const bom = '\uFEFF';
                      const csvContent = rows.map(row => row.join(',')).join('\n');
                      const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = `${patient.displayId}_臨床経過.csv`;
                      link.click();
                      URL.revokeObjectURL(url);
                    };

                    // SVGダウンロード（検査データ・治療薬・臨床経過すべて含む）
                    const downloadSVG = () => {
                      // 治療薬と臨床経過のカテゴリ色
                      const categoryColors = {
                        '抗てんかん薬': '#f59e0b', 'ステロイド': '#22c55e', '免疫グロブリン': '#3b82f6',
                        '血漿交換': '#6366f1', '免疫抑制剤': '#ec4899', '抗ウイルス薬': '#14b8a6',
                        '抗菌薬': '#eab308', '抗浮腫薬': '#0ea5e9', 'その他': '#6b7280'
                      };
                      const eventSvgColors = {
                        '意識障害': '#dc2626', 'てんかん発作': '#ea580c', '不随意運動': '#d97706',
                        '麻痺': '#ca8a04', '感覚障害': '#65a30d', '失語': '#16a34a',
                        '認知機能障害': '#0d9488', '精神症状': '#0891b2', '発熱': '#ef4444',
                        '頭痛': '#f97316', '髄膜刺激症状': '#84cc16', '人工呼吸器管理': '#7c3aed', 'ICU入室': '#9333ea'
                      };
                      const labColors = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#6366f1'];

                      const width = 900;
                      const leftMargin = 130;
                      const rightMargin = 60;
                      const graphWidth = width - leftMargin - rightMargin;
                      let yPos = 50;
                      const barHeight = 30;
                      const maxBarHeight = 40;

                      // 高さを動的に計算
                      const hasTreatments = showTreatmentsOnChart && selectedTreatmentsForChart.length > 0;
                      const hasEvents = showEventsOnChart && selectedEventsForChart.length > 0;
                      const hasLabData = selectedLabItemsForChart.length > 0;

                      let totalHeight = 80; // タイトル + マージン
                      if (hasTreatments) {
                        const treatmentGroups = {};
                        treatments.filter(t => selectedTreatmentsForChart.includes(t.medicationName)).forEach(t => {
                          treatmentGroups[t.medicationName] = true;
                        });
                        totalHeight += Object.keys(treatmentGroups).length * (maxBarHeight + 15) + 20;
                      }
                      if (hasEvents) {
                        const eventGroups = {};
                        clinicalEvents.filter(e => selectedEventsForChart.includes(e.eventType)).forEach(e => {
                          eventGroups[e.eventType] = true;
                        });
                        // 頻度/重症度ベースの場合はmaxBarHeight(50)を使用
                        const maxEventBarHeight = 50;
                        totalHeight += Object.keys(eventGroups).length * (maxEventBarHeight + 15) + 20;
                      }
                      if (hasLabData) {
                        totalHeight += 250; // グラフエリア
                      }
                      totalHeight += 60; // X軸 + 余白

                      let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" style="font-family: sans-serif; background: white;">`;
                      svgContent += `<rect width="${width}" height="${totalHeight}" fill="white"/>`;
                      svgContent += `<text x="${width/2}" y="30" text-anchor="middle" font-size="16" font-weight="bold">臨床経過 - ${patient.displayId}</text>`;

                      // 治療薬タイムライン
                      if (showTreatmentsOnChart && selectedTreatmentsForChart.length > 0) {
                        const groups = {};
                        treatments.filter(t => selectedTreatmentsForChart.includes(t.medicationName)).forEach(t => {
                          if (!groups[t.medicationName]) {
                            groups[t.medicationName] = { name: t.medicationName, category: t.category, entries: [], unit: t.dosageUnit || '' };
                          }
                          groups[t.medicationName].entries.push(t);
                        });

                        Object.values(groups).forEach(group => {
                          group.entries.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                          const color = categoryColors[group.category] || '#6b7280';
                          const shortName = group.name.replace(/（.*）/g, '').replace(/\(.*\)/g, '');
                          const unitText = group.unit ? `[${group.unit.replace('/日', '')}]` : '';
                          const maxDosage = Math.max(...group.entries.map(e => parseFloat(e.dosage) || 0), 1);

                          svgContent += `<text x="${leftMargin - 8}" y="${yPos + maxBarHeight - 5}" text-anchor="end" font-size="10">${shortName}${unitText}</text>`;
                          svgContent += `<line x1="${leftMargin}" y1="${yPos + maxBarHeight}" x2="${width - 40}" y2="${yPos + maxBarHeight}" stroke="#d1d5db" stroke-width="1"/>`;

                          group.entries.forEach(entry => {
                            const startDay = calcDaysFromOnset(entry.startDate);
                            const endDay = entry.endDate ? calcDaysFromOnset(entry.endDate) : startDay;
                            const x = leftMargin + ((startDay - minDay) / dayRange) * graphWidth;
                            const w = Math.max(((endDay - startDay) / dayRange) * graphWidth, 8);
                            const dosage = parseFloat(entry.dosage) || 0;
                            const h = Math.max((dosage / maxDosage) * maxBarHeight, 8);
                            const y = yPos + maxBarHeight - h;
                            svgContent += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" rx="2"/>`;
                            if (w > 20 && h > 12) {
                              svgContent += `<text x="${x + w/2}" y="${y + h/2 + 3}" text-anchor="middle" font-size="8" fill="white">${entry.dosage}</text>`;
                            }
                          });
                          yPos += maxBarHeight + 15;
                        });
                      }

                      // 臨床経過タイムライン（頻度/重症度に応じたバー高さ）
                      if (showEventsOnChart && selectedEventsForChart.length > 0) {
                        // レベル定義
                        const svgFrequencyLevels = {
                          'hourly': { level: 7, label: '毎時' },
                          'several_daily': { level: 6, label: '数回/日' },
                          'daily': { level: 5, label: '毎日' },
                          'several_weekly': { level: 4, label: '数回/週' },
                          'weekly': { level: 3, label: '週1' },
                          'monthly': { level: 2, label: '月1' },
                          'rare': { level: 1, label: '稀' }
                        };
                        const svgJcsLevels = {
                          '0': { level: 0, label: '清明' },
                          'I-1': { level: 1, label: 'I-1' },
                          'I-2': { level: 2, label: 'I-2' },
                          'I-3': { level: 3, label: 'I-3' },
                          'II-10': { level: 4, label: 'II-10' },
                          'II-20': { level: 5, label: 'II-20' },
                          'II-30': { level: 6, label: 'II-30' },
                          'III-100': { level: 7, label: 'III-100' },
                          'III-200': { level: 8, label: 'III-200' },
                          'III-300': { level: 9, label: 'III-300' }
                        };
                        const svgSeverityLevels = {
                          '軽症': { level: 1, label: '軽症' },
                          '軽度': { level: 1, label: '軽度' },
                          '中等症': { level: 2, label: '中等症' },
                          '中等度': { level: 2, label: '中等度' },
                          '重症': { level: 3, label: '重症' },
                          '重度': { level: 3, label: '重度' }
                        };

                        const groups = {};
                        clinicalEvents.filter(e => selectedEventsForChart.includes(e.eventType)).forEach(e => {
                          if (!groups[e.eventType]) {
                            groups[e.eventType] = { type: e.eventType, entries: [], inputType: e.inputType };
                          }
                          groups[e.eventType].entries.push(e);
                        });

                        Object.values(groups).forEach(group => {
                          group.entries.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                          const color = eventSvgColors[group.type] || '#6b7280';

                          // 頻度/重症度ベースかどうか判定
                          const isFrequencyBased = group.entries.some(e => e.frequency);
                          const isJCSBased = group.entries.some(e => e.jcs);
                          const isSeverityBased = group.entries.some(e => e.severity);
                          const hasLevels = isFrequencyBased || isJCSBased || isSeverityBased;

                          const maxEventBarHeight = hasLevels ? 50 : 30;
                          let maxLevel = 7;
                          if (isJCSBased) maxLevel = 9;
                          if (isSeverityBased) maxLevel = 3;

                          svgContent += `<text x="${leftMargin - 8}" y="${yPos + maxEventBarHeight - 5}" text-anchor="end" font-size="10">${group.type}</text>`;
                          svgContent += `<line x1="${leftMargin}" y1="${yPos + maxEventBarHeight}" x2="${width - 40}" y2="${yPos + maxEventBarHeight}" stroke="#d1d5db" stroke-width="1"/>`;

                          group.entries.forEach(entry => {
                            const startDay = calcDaysFromOnset(entry.startDate);
                            const endDay = entry.endDate ? calcDaysFromOnset(entry.endDate) : startDay;
                            const x = leftMargin + ((startDay - minDay) / dayRange) * graphWidth;
                            const w = Math.max(((endDay - startDay) / dayRange) * graphWidth, 8);

                            // レベルとラベルを決定
                            let level = maxLevel;
                            let labelText = '';
                            if (entry.frequency && svgFrequencyLevels[entry.frequency]) {
                              level = svgFrequencyLevels[entry.frequency].level;
                              labelText = svgFrequencyLevels[entry.frequency].label;
                            } else if (entry.jcs && svgJcsLevels[entry.jcs]) {
                              level = svgJcsLevels[entry.jcs].level;
                              labelText = svgJcsLevels[entry.jcs].label;
                            } else if (entry.severity && svgSeverityLevels[entry.severity]) {
                              level = svgSeverityLevels[entry.severity].level;
                              labelText = svgSeverityLevels[entry.severity].label;
                            }

                            // 高さを計算
                            const h = hasLevels ? Math.max((level / maxLevel) * maxEventBarHeight, 12) : maxEventBarHeight;
                            const y = yPos + maxEventBarHeight - h;

                            svgContent += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" rx="2"/>`;
                            if (w > 20 && h > 14 && labelText) {
                              svgContent += `<text x="${x + w/2}" y="${y + h/2 + 3}" text-anchor="middle" font-size="8" fill="white">${labelText}</text>`;
                            }
                          });
                          yPos += maxEventBarHeight + 15;
                        });
                      }

                      // 検査データグラフ
                      if (hasLabData) {
                        yPos += 20;
                        svgContent += `<text x="${leftMargin}" y="${yPos}" font-size="11" font-weight="bold">【検査値】</text>`;
                        yPos += 10;

                        const chartHeight = 200;
                        const chartTop = yPos;
                        const chartBottom = yPos + chartHeight;

                        // グラフ背景とグリッド
                        svgContent += `<rect x="${leftMargin}" y="${chartTop}" width="${graphWidth}" height="${chartHeight}" fill="#f9fafb" stroke="#e5e7eb"/>`;
                        for (let i = 1; i < 5; i++) {
                          const gridY = chartTop + (chartHeight / 5) * i;
                          svgContent += `<line x1="${leftMargin}" y1="${gridY}" x2="${leftMargin + graphWidth}" y2="${gridY}" stroke="#e5e7eb" stroke-dasharray="3,3"/>`;
                        }

                        // 各検査項目のデータを描画
                        selectedLabItemsForChart.forEach((itemName, itemIdx) => {
                          const color = labColors[itemIdx % labColors.length];
                          const dataPoints = [];

                          labResults.forEach(lab => {
                            const day = calcDaysFromOnset(lab.date);
                            const labItem = lab.data?.find(d => d.item === itemName);
                            if (day !== null && labItem && labItem.value !== '' && !isNaN(parseFloat(labItem.value))) {
                              dataPoints.push({ day, value: parseFloat(labItem.value) });
                            }
                          });

                          if (dataPoints.length === 0) return;

                          dataPoints.sort((a, b) => a.day - b.day);

                          // 値の範囲を計算
                          const values = dataPoints.map(p => p.value);
                          const minVal = Math.min(...values);
                          const maxVal = Math.max(...values);
                          const valRange = maxVal - minVal || 1;

                          // パスを生成
                          let pathD = '';
                          dataPoints.forEach((point, idx) => {
                            const x = leftMargin + ((point.day - minDay) / dayRange) * graphWidth;
                            const y = chartBottom - ((point.value - minVal) / valRange) * (chartHeight - 20) - 10;
                            if (idx === 0) {
                              pathD = `M ${x} ${y}`;
                            } else {
                              pathD += ` L ${x} ${y}`;
                            }
                          });

                          svgContent += `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2"/>`;

                          // データポイント
                          dataPoints.forEach(point => {
                            const x = leftMargin + ((point.day - minDay) / dayRange) * graphWidth;
                            const y = chartBottom - ((point.value - minVal) / valRange) * (chartHeight - 20) - 10;
                            svgContent += `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`;
                          });

                          // 凡例
                          const legendX = leftMargin + graphWidth + 10;
                          const legendY = chartTop + 15 + itemIdx * 18;
                          svgContent += `<line x1="${legendX}" y1="${legendY}" x2="${legendX + 15}" y2="${legendY}" stroke="${color}" stroke-width="2"/>`;
                          svgContent += `<text x="${legendX + 20}" y="${legendY + 4}" font-size="9">${itemName}</text>`;
                        });

                        yPos = chartBottom + 10;
                      }

                      // X軸
                      yPos += 10;
                      svgContent += `<line x1="${leftMargin}" y1="${yPos}" x2="${leftMargin + graphWidth}" y2="${yPos}" stroke="#333" stroke-width="1"/>`;
                      for (let d = Math.ceil(minDay / 5) * 5; d <= maxDay; d += 5) {
                        const x = leftMargin + ((d - minDay) / dayRange) * graphWidth;
                        svgContent += `<line x1="${x}" y1="${yPos}" x2="${x}" y2="${yPos + 5}" stroke="#333" stroke-width="1"/>`;
                        svgContent += `<text x="${x}" y="${yPos + 15}" text-anchor="middle" font-size="9">${d}</text>`;
                      }
                      svgContent += `<text x="${leftMargin + graphWidth/2}" y="${yPos + 30}" text-anchor="middle" font-size="10">Days from onset</text>`;

                      svgContent += '</svg>';

                      const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = `${patient.displayId}_臨床経過.svg`;
                      link.click();
                      URL.revokeObjectURL(url);
                    };

                    // タイムライン描画コンポーネント（スクリーンショット風）
                    const renderClinicalTimeline = () => {
                      const hasTreatments = showTreatmentsOnChart && selectedTreatmentsForChart.length > 0;
                      const hasEvents = showEventsOnChart && selectedEventsForChart.length > 0;

                      if (!hasTreatments && !hasEvents) return null;

                      // 左マージン（薬剤名表示エリア）
                      const leftMargin = 120;
                      // カテゴリ別の色
                      const categoryColors = {
                        '抗てんかん薬': '#f59e0b',
                        'ステロイド': '#22c55e',
                        '免疫グロブリン': '#3b82f6',
                        '血漿交換': '#6366f1',
                        '免疫抑制剤': '#ec4899',
                        '抗ウイルス薬': '#14b8a6',
                        '抗菌薬': '#eab308',
                        '抗浮腫薬': '#0ea5e9',
                        'その他': '#6b7280'
                      };

                      return (
                        <div style={{ marginBottom: '0' }}>
                          {/* 治療薬タイムライン（用量を高さで表現） */}
                          {hasTreatments && (
                            <div style={{ marginBottom: hasEvents ? '16px' : '0' }}>
                              {(() => {
                                // 選択された薬剤でグループ化
                                const groups = {};
                                treatments.filter(t => selectedTreatmentsForChart.includes(t.medicationName)).forEach(t => {
                                  if (!groups[t.medicationName]) {
                                    groups[t.medicationName] = { name: t.medicationName, category: t.category, entries: [], unit: t.dosageUnit || '' };
                                  }
                                  groups[t.medicationName].entries.push(t);
                                });
                                Object.values(groups).forEach(g => g.entries.sort((a, b) => new Date(a.startDate) - new Date(b.startDate)));

                                return Object.values(groups).map((group, gIdx) => {
                                  const color = categoryColors[group.category] || '#6b7280';
                                  const maxBarHeight = 40;
                                  const maxDosage = Math.max(...group.entries.map(e => parseFloat(e.dosage) || 0), 1);
                                  // 短縮名を取得（括弧内を除去）
                                  const shortName = group.name.replace(/（.*）/g, '').replace(/\(.*\)/g, '');
                                  const unitText = group.unit ? `[${group.unit.replace('/日', '')}]` : '';

                                  return (
                                    <div key={gIdx} style={{display: 'flex', alignItems: 'flex-end', height: `${maxBarHeight + 12}px`, marginBottom: '4px'}}>
                                      <div style={{
                                        width: `${leftMargin}px`,
                                        flexShrink: 0,
                                        fontSize: '11px',
                                        color: '#333',
                                        paddingRight: '8px',
                                        textAlign: 'right',
                                        fontWeight: '500',
                                        paddingBottom: '4px'
                                      }} title={group.name}>
                                        {shortName}{unitText}
                                      </div>
                                      <div style={{
                                        flex: 1,
                                        position: 'relative',
                                        height: `${maxBarHeight}px`,
                                        borderBottom: '1px solid #d1d5db'
                                      }}>
                                        {group.entries.map((entry, eIdx) => {
                                          const startDay = calcDaysFromOnset(entry.startDate);
                                          const endDay = entry.endDate ? calcDaysFromOnset(entry.endDate) : startDay;
                                          const leftPercent = ((startDay - minDay) / dayRange) * 100;
                                          const widthPercent = Math.max(((endDay - startDay) / dayRange) * 100, 2);
                                          const dosage = parseFloat(entry.dosage) || 0;
                                          const heightPercent = (dosage / maxDosage) * 100;
                                          const barHeight = Math.max((heightPercent / 100) * maxBarHeight, 8);
                                          const dosageText = entry.dosage || '';

                                          return (
                                            <div
                                              key={eIdx}
                                              style={{
                                                position: 'absolute',
                                                left: `${leftPercent}%`,
                                                width: `${widthPercent}%`,
                                                height: `${barHeight}px`,
                                                bottom: '0',
                                                background: color,
                                                borderRadius: '2px 2px 0 0',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                fontSize: '9px',
                                                fontWeight: '600',
                                                color: 'white',
                                                textShadow: '0 0 2px rgba(0,0,0,0.5)',
                                                overflow: 'hidden',
                                                boxSizing: 'border-box'
                                              }}
                                              title={`${group.name}: Day ${startDay}〜${endDay} (${entry.dosage}${entry.dosageUnit || ''})`}
                                            >
                                              {widthPercent > 4 && barHeight > 14 && dosageText}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                });
                              })()}
                            </div>
                          )}

                          {/* 臨床経過タイムライン（頻度の増減を高さで表現、同じ症状は同じ色） */}
                          {hasEvents && (
                            <div>
                              {(() => {
                                // 頻度レベルの定義（高いほど頻度が高い）
                                const frequencyLevels = {
                                  'hourly': { level: 7, label: '毎時' },
                                  'several_daily': { level: 6, label: '数回/日' },
                                  'daily': { level: 5, label: '毎日' },
                                  'several_weekly': { level: 4, label: '数回/週' },
                                  'weekly': { level: 3, label: '週1' },
                                  'monthly': { level: 2, label: '月1' },
                                  'rare': { level: 1, label: '稀' }
                                };

                                // JCSレベルの定義
                                const jcsLevels = {
                                  '0': { level: 0, label: '清明' },
                                  'I-1': { level: 1, label: 'I-1' },
                                  'I-2': { level: 2, label: 'I-2' },
                                  'I-3': { level: 3, label: 'I-3' },
                                  'II-10': { level: 4, label: 'II-10' },
                                  'II-20': { level: 5, label: 'II-20' },
                                  'II-30': { level: 6, label: 'II-30' },
                                  'III-100': { level: 7, label: 'III-100' },
                                  'III-200': { level: 8, label: 'III-200' },
                                  'III-300': { level: 9, label: 'III-300' }
                                };

                                // 重症度レベル
                                const severityLevels = {
                                  '軽度': { level: 1, label: '軽度' },
                                  '中等度': { level: 2, label: '中等度' },
                                  '重度': { level: 3, label: '重度' }
                                };

                                // 選択されたイベントでグループ化
                                const groups = {};
                                clinicalEvents.filter(e => selectedEventsForChart.includes(e.eventType)).forEach(e => {
                                  if (!groups[e.eventType]) {
                                    groups[e.eventType] = { type: e.eventType, entries: [], inputType: e.inputType };
                                  }
                                  groups[e.eventType].entries.push(e);
                                });
                                Object.values(groups).forEach(g => g.entries.sort((a, b) => new Date(a.startDate) - new Date(b.startDate)));

                                return Object.values(groups).map((group, gIdx) => {
                                  const barStyle = eventBarColors[group.type] || { bg: '#F8F9FA', border: '#ADB5BD' };

                                  // 頻度ベースのイベントかどうか判定
                                  const isFrequencyBased = group.entries.some(e => e.frequency);
                                  const isJCSBased = group.entries.some(e => e.jcs);
                                  const isSeverityBased = group.entries.some(e => e.severity);
                                  const hasLevels = isFrequencyBased || isJCSBased || isSeverityBased;

                                  // レベルベースの表示の場合は高さを可変に
                                  const maxBarHeight = hasLevels ? 50 : 22;
                                  let maxLevel = 7; // デフォルト
                                  if (isJCSBased) maxLevel = 9;
                                  if (isSeverityBased) maxLevel = 3;

                                  return (
                                    <div key={gIdx} style={{display: 'flex', alignItems: hasLevels ? 'flex-end' : 'center', height: `${maxBarHeight + 12}px`, marginBottom: '4px'}}>
                                      <div style={{
                                        width: `${leftMargin}px`,
                                        flexShrink: 0,
                                        fontSize: '11px',
                                        color: '#333',
                                        paddingRight: '8px',
                                        textAlign: 'right',
                                        fontWeight: '500',
                                        paddingBottom: hasLevels ? '4px' : '0'
                                      }}>
                                        {group.type}
                                      </div>
                                      <div style={{
                                        flex: 1,
                                        position: 'relative',
                                        height: `${maxBarHeight}px`
                                      }}>
                                        {group.entries.map((entry, eIdx) => {
                                          const startDay = calcDaysFromOnset(entry.startDate);
                                          const endDay = entry.endDate ? calcDaysFromOnset(entry.endDate) : startDay;
                                          const leftPercent = ((startDay - minDay) / dayRange) * 100;
                                          const widthPercent = Math.max(((endDay - startDay) / dayRange) * 100, 2);

                                          // レベルとラベルを決定（色は症状ごとに固定）
                                          let level = maxLevel; // デフォルトは最大
                                          let labelText = '';

                                          if (entry.frequency && frequencyLevels[entry.frequency]) {
                                            const freq = frequencyLevels[entry.frequency];
                                            level = freq.level;
                                            labelText = freq.label;
                                          } else if (entry.jcs && jcsLevels[entry.jcs]) {
                                            const jcs = jcsLevels[entry.jcs];
                                            level = jcs.level;
                                            labelText = jcs.label;
                                          } else if (entry.severity && severityLevels[entry.severity]) {
                                            const sev = severityLevels[entry.severity];
                                            level = sev.level;
                                            labelText = sev.label;
                                          }

                                          // 高さを計算（レベルベースの場合）
                                          const barHeight = hasLevels
                                            ? Math.max((level / maxLevel) * maxBarHeight, 12)
                                            : maxBarHeight;

                                          return (
                                            <div
                                              key={eIdx}
                                              style={{
                                                position: 'absolute',
                                                left: `${leftPercent}%`,
                                                width: `${widthPercent}%`,
                                                height: `${barHeight}px`,
                                                bottom: 0,
                                                background: barStyle.border,
                                                border: 'none',
                                                borderRadius: '2px 2px 0 0',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                fontSize: '9px',
                                                fontWeight: '600',
                                                color: '#fff',
                                                overflow: 'hidden',
                                                boxSizing: 'border-box',
                                                opacity: 0.85
                                              }}
                                              title={`${group.type}: Day ${startDay}〜${endDay}${labelText ? ` (${labelText})` : ''}`}
                                            >
                                              {widthPercent > 4 && barHeight > 14 && labelText}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                });
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    };

                    // ダミー用（古いrenderTimeline参照を維持）
                    const renderTimeline = renderClinicalTimeline;

                    // 検査データのグラフ（X軸をタイムラインと揃える）
                    const renderLabChartAligned = () => {
                      if (selectedLabItemsForChart.length === 0) return null;

                      const datasets = [];
                      selectedLabItemsForChart.forEach((item, idx) => {
                        const dataPoints = [];
                        labResults.forEach(lab => {
                          const labItem = lab.data?.find(d => d.item === item);
                          if (labItem) {
                            const day = calcDaysFromOnset(lab.date);
                            if (day !== null) {
                              dataPoints.push({ x: day, y: labItem.value });
                            }
                          }
                        });
                        if (dataPoints.length > 0) {
                          dataPoints.sort((a, b) => a.x - b.x);
                          datasets.push({
                            label: item,
                            data: dataPoints,
                            borderColor: labColors[idx % labColors.length],
                            backgroundColor: labColors[idx % labColors.length],
                            tension: 0.2,
                            pointRadius: 4,
                            pointHoverRadius: 6,
                            borderWidth: 2
                          });
                        }
                      });

                      if (datasets.length === 0) return null;

                      return (
                        <div style={{ marginLeft: '120px' }}>
                          <Line
                            ref={overlayChartRef}
                            data={{ datasets }}
                            options={{
                              responsive: true,
                              maintainAspectRatio: true,
                              aspectRatio: 2.5,
                              interaction: {
                                mode: 'index',
                                intersect: false
                              },
                              plugins: {
                                legend: {
                                  position: 'right',
                                  labels: {
                                    usePointStyle: true,
                                    padding: 12,
                                    font: { size: 11 }
                                  }
                                },
                                title: {
                                  display: false
                                }
                              },
                              scales: {
                                x: {
                                  type: 'linear',
                                  min: minDay,
                                  max: maxDay,
                                  title: {
                                    display: true,
                                    text: 'days',
                                    font: { size: 11 }
                                  },
                                  ticks: {
                                    stepSize: 5,
                                    font: { size: 10 }
                                  },
                                  grid: {
                                    color: '#e5e7eb'
                                  }
                                },
                                y: {
                                  type: 'linear',
                                  position: 'left',
                                  grid: {
                                    color: '#e5e7eb'
                                  },
                                  ticks: {
                                    font: { size: 10 }
                                  }
                                }
                              }
                            }}
                          />
                        </div>
                      );
                    };

                    // 古いダミー関数（参照維持用）
                    const renderLabChart = renderLabChartAligned;

                    // オーバーレイモードのグラフも同様にダミー化
                    const renderOverlayChart = () => {
                      // overlay modeではこれまで通り全部重ねる
                      const datasets = [];
                      selectedLabItemsForChart.forEach((item, idx) => {
                        const dataPoints = [];
                        labResults.forEach(lab => {
                          const labItem = lab.data?.find(d => d.item === item);
                          if (labItem) {
                            const day = calcDaysFromOnset(lab.date);
                            if (day !== null) {
                              dataPoints.push({ x: day, y: labItem.value });
                            }
                          }
                        });
                        if (dataPoints.length > 0) {
                          dataPoints.sort((a, b) => a.x - b.x);
                          datasets.push({
                            label: item,
                            data: dataPoints,
                            borderColor: labColors[idx % labColors.length],
                            backgroundColor: labColors[idx % labColors.length] + '20',
                            tension: 0.2,
                            yAxisID: 'y',
                            pointRadius: 4,
                            pointHoverRadius: 6
                          });
                        }
                      });

                      const overlayTreatmentColors = ['#22c55e', '#14b8a6', '#0ea5e9', '#6366f1', '#a855f7', '#f43f5e'];
                      if (showTreatmentsOnChart) {
                        selectedTreatmentsForChart.forEach((medName, idx) => {
                          const medTreatments = treatments.filter(t => t.medicationName === medName);
                          const dataPoints = [];
                          medTreatments.forEach(t => {
                            const startDay = calcDaysFromOnset(t.startDate);
                            const endDay = t.endDate ? calcDaysFromOnset(t.endDate) : startDay;
                            const dosage = parseFloat(t.dosage) || 0;
                            if (startDay !== null) {
                              dataPoints.push({ x: startDay, y: dosage });
                              if (endDay !== startDay) dataPoints.push({ x: endDay, y: dosage });
                            }
                          });
                          if (dataPoints.length > 0) {
                            dataPoints.sort((a, b) => a.x - b.x);
                            datasets.push({
                              label: `💊 ${medName}`,
                              data: dataPoints,
                              borderColor: overlayTreatmentColors[idx % overlayTreatmentColors.length],
                              backgroundColor: overlayTreatmentColors[idx % overlayTreatmentColors.length] + '30',
                              stepped: 'before',
                              fill: true,
                              yAxisID: 'y1',
                              borderWidth: 2,
                              pointRadius: 3
                            });
                          }
                        });
                      }

                      const overlayEventColors = ['#dc2626', '#ea580c', '#d97706', '#ca8a04', '#65a30d', '#16a34a', '#0d9488'];
                      if (showEventsOnChart) {
                        selectedEventsForChart.forEach((eventType, idx) => {
                          const typeEvents = clinicalEvents.filter(e => e.eventType === eventType);
                          const dataPoints = [];
                          typeEvents.forEach(e => {
                            const startDay = calcDaysFromOnset(e.startDate);
                            const endDay = e.endDate ? calcDaysFromOnset(e.endDate) : startDay;
                            const score = getSeverityScore(e);
                            if (startDay !== null) {
                              dataPoints.push({ x: startDay, y: score });
                              if (endDay !== startDay) dataPoints.push({ x: endDay, y: score });
                            }
                          });
                          if (dataPoints.length > 0) {
                            dataPoints.sort((a, b) => a.x - b.x);
                            datasets.push({
                              label: `📋 ${eventType}`,
                              data: dataPoints,
                              borderColor: overlayEventColors[idx % overlayEventColors.length],
                              backgroundColor: overlayEventColors[idx % overlayEventColors.length] + '20',
                              stepped: 'before',
                              fill: true,
                              yAxisID: 'y2',
                              borderWidth: 2,
                              borderDash: [5, 5],
                              pointRadius: 4
                            });
                          }
                        });
                      }

                      if (datasets.length === 0) return null;

                      const hasLabData = selectedLabItemsForChart.length > 0;
                      const hasTreatmentData = showTreatmentsOnChart && selectedTreatmentsForChart.length > 0;
                      const hasEventData = showEventsOnChart && selectedEventsForChart.length > 0;
                      const scales = { x: { type: 'linear', title: { display: true, text: 'days' } } };
                      if (hasLabData) scales.y = { type: 'linear', position: 'left', title: { display: true, text: '検査値' } };
                      if (hasTreatmentData) scales.y1 = { type: 'linear', position: 'right', title: { display: true, text: '投与量' }, grid: { drawOnChartArea: false } };
                      if (hasEventData) scales.y2 = { type: 'linear', position: hasLabData ? 'right' : 'left', title: { display: true, text: '重症度' }, grid: { drawOnChartArea: false } };

                      return (
                        <Line
                          ref={overlayChartRef}
                          data={{ datasets }}
                          options={{
                            responsive: true,
                            interaction: { mode: 'index', intersect: false },
                            plugins: {
                              legend: { position: 'top', labels: { usePointStyle: true, padding: 15 } },
                              title: { display: true, text: `${patient.displayId} - 経時データ分析` }
                            },
                            scales
                          }}
                        />
                      );
                    };

                    // 分離モードとオーバーレイモードで表示を切り替え
                    const isSeparateMode = timelineDisplayMode === 'separate';
                    const showTimelineAbove = isSeparateMode && timelinePosition === 'above';
                    const showTimelineBelow = isSeparateMode && timelinePosition === 'below';

                    return (
                      <div>
                        {/* タイトル */}
                        <h3 style={{
                          textAlign: 'center',
                          fontSize: '16px',
                          fontWeight: '600',
                          color: '#1f2937',
                          marginBottom: '16px',
                          paddingBottom: '12px',
                          borderBottom: '1px solid #e5e7eb'
                        }}>
                          臨床経過
                        </h3>

                        {/* 経過表（上に配置） */}
                        {showTimelineAbove && renderClinicalTimeline()}
                        {showTimelineAbove && (showTreatmentsOnChart || showEventsOnChart) && <div style={{height: '16px'}} />}

                        {/* グラフ */}
                        {isSeparateMode ? renderLabChartAligned() : renderOverlayChart()}

                        {/* 経過表（下に配置） */}
                        {showTimelineBelow && selectedLabItemsForChart.length > 0 && <div style={{height: '16px'}} />}
                        {showTimelineBelow && renderClinicalTimeline()}

                        {/* エクスポートボタン */}
                        <div style={{
                          display: 'flex',
                          gap: '12px',
                          marginTop: '20px',
                          justifyContent: 'center',
                          paddingTop: '16px',
                          borderTop: '1px solid #e5e7eb'
                        }}>
                          <button
                            onClick={() => {
                              // SVGを生成してPNGに変換
                              const generatePNG = () => {
                                const categoryColors = {
                                  '抗てんかん薬': '#f59e0b', 'ステロイド': '#22c55e', '免疫グロブリン': '#3b82f6',
                                  '血漿交換': '#6366f1', '免疫抑制剤': '#ec4899', '抗ウイルス薬': '#14b8a6',
                                  '抗菌薬': '#eab308', '抗浮腫薬': '#0ea5e9', 'その他': '#6b7280'
                                };
                                const eventPngColors = {
                                  '意識障害': '#dc2626', 'てんかん発作': '#ea580c', '不随意運動': '#d97706',
                                  '麻痺': '#ca8a04', '感覚障害': '#65a30d', '失語': '#16a34a',
                                  '認知機能障害': '#0d9488', '精神症状': '#0891b2', '発熱': '#ef4444',
                                  '頭痛': '#f97316', '髄膜刺激症状': '#84cc16', '人工呼吸器管理': '#7c3aed', 'ICU入室': '#9333ea'
                                };
                                const labPngColors = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#6366f1'];

                                const width = 900;
                                const leftMargin = 130;
                                const rightMargin = 80;
                                const graphWidth = width - leftMargin - rightMargin;
                                let yPos = 50;
                                const barHeight = 30;
                                const maxBarHeight = 40;

                                const hasTreatments = showTreatmentsOnChart && selectedTreatmentsForChart.length > 0;
                                const hasEvents = showEventsOnChart && selectedEventsForChart.length > 0;
                                const hasLabData = selectedLabItemsForChart.length > 0;

                                let totalHeight = 80;
                                if (hasTreatments) {
                                  const tGroups = {};
                                  treatments.filter(t => selectedTreatmentsForChart.includes(t.medicationName)).forEach(t => { tGroups[t.medicationName] = true; });
                                  totalHeight += Object.keys(tGroups).length * (maxBarHeight + 15) + 20;
                                }
                                if (hasEvents) {
                                  const eGroups = {};
                                  clinicalEvents.filter(e => selectedEventsForChart.includes(e.eventType)).forEach(e => { eGroups[e.eventType] = true; });
                                  // 頻度/重症度ベースの場合はmaxEventBarHeight(50)を使用
                                  const maxEventBarHeight = 50;
                                  totalHeight += Object.keys(eGroups).length * (maxEventBarHeight + 15) + 20;
                                }
                                if (hasLabData) totalHeight += 250;
                                totalHeight += 60;

                                let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" style="font-family: sans-serif; background: white;">`;
                                svg += `<rect width="${width}" height="${totalHeight}" fill="white"/>`;
                                svg += `<text x="${width/2}" y="30" text-anchor="middle" font-size="16" font-weight="bold">臨床経過 - ${patient.displayId}</text>`;

                                // 治療薬タイムライン
                                if (hasTreatments) {
                                  const groups = {};
                                  treatments.filter(t => selectedTreatmentsForChart.includes(t.medicationName)).forEach(t => {
                                    if (!groups[t.medicationName]) groups[t.medicationName] = { name: t.medicationName, category: t.category, entries: [], unit: t.dosageUnit || '' };
                                    groups[t.medicationName].entries.push(t);
                                  });
                                  Object.values(groups).forEach(group => {
                                    group.entries.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                                    const color = categoryColors[group.category] || '#6b7280';
                                    const shortName = group.name.replace(/（.*）/g, '').replace(/\(.*\)/g, '');
                                    const unitText = group.unit ? `[${group.unit.replace('/日', '')}]` : '';
                                    const maxDosage = Math.max(...group.entries.map(e => parseFloat(e.dosage) || 0), 1);
                                    svg += `<text x="${leftMargin - 8}" y="${yPos + maxBarHeight - 5}" text-anchor="end" font-size="10">${shortName}${unitText}</text>`;
                                    svg += `<line x1="${leftMargin}" y1="${yPos + maxBarHeight}" x2="${leftMargin + graphWidth}" y2="${yPos + maxBarHeight}" stroke="#d1d5db" stroke-width="1"/>`;
                                    group.entries.forEach(entry => {
                                      const startDay = calcDaysFromOnset(entry.startDate);
                                      const endDay = entry.endDate ? calcDaysFromOnset(entry.endDate) : startDay;
                                      const x = leftMargin + ((startDay - minDay) / dayRange) * graphWidth;
                                      const w = Math.max(((endDay - startDay) / dayRange) * graphWidth, 8);
                                      const dosage = parseFloat(entry.dosage) || 0;
                                      const h = Math.max((dosage / maxDosage) * maxBarHeight, 8);
                                      const y = yPos + maxBarHeight - h;
                                      svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" rx="2"/>`;
                                      if (w > 20 && h > 12) svg += `<text x="${x + w/2}" y="${y + h/2 + 3}" text-anchor="middle" font-size="8" fill="white">${entry.dosage}</text>`;
                                    });
                                    yPos += maxBarHeight + 15;
                                  });
                                }

                                // 臨床経過タイムライン（頻度/重症度に応じたバー高さ）
                                if (hasEvents) {
                                  // レベル定義
                                  const pngFrequencyLevels = {
                                    'hourly': { level: 7, label: '毎時' },
                                    'several_daily': { level: 6, label: '数回/日' },
                                    'daily': { level: 5, label: '毎日' },
                                    'several_weekly': { level: 4, label: '数回/週' },
                                    'weekly': { level: 3, label: '週1' },
                                    'monthly': { level: 2, label: '月1' },
                                    'rare': { level: 1, label: '稀' }
                                  };
                                  const pngJcsLevels = {
                                    '0': { level: 0, label: '清明' },
                                    'I-1': { level: 1, label: 'I-1' },
                                    'I-2': { level: 2, label: 'I-2' },
                                    'I-3': { level: 3, label: 'I-3' },
                                    'II-10': { level: 4, label: 'II-10' },
                                    'II-20': { level: 5, label: 'II-20' },
                                    'II-30': { level: 6, label: 'II-30' },
                                    'III-100': { level: 7, label: 'III-100' },
                                    'III-200': { level: 8, label: 'III-200' },
                                    'III-300': { level: 9, label: 'III-300' }
                                  };
                                  const pngSeverityLevels = {
                                    '軽症': { level: 1, label: '軽症' },
                                    '軽度': { level: 1, label: '軽度' },
                                    '中等症': { level: 2, label: '中等症' },
                                    '中等度': { level: 2, label: '中等度' },
                                    '重症': { level: 3, label: '重症' },
                                    '重度': { level: 3, label: '重度' }
                                  };

                                  const groups = {};
                                  clinicalEvents.filter(e => selectedEventsForChart.includes(e.eventType)).forEach(e => {
                                    if (!groups[e.eventType]) groups[e.eventType] = { type: e.eventType, entries: [], inputType: e.inputType };
                                    groups[e.eventType].entries.push(e);
                                  });
                                  Object.values(groups).forEach(group => {
                                    group.entries.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                                    const color = eventPngColors[group.type] || '#6b7280';

                                    // 頻度/重症度ベースかどうか判定
                                    const isFrequencyBased = group.entries.some(e => e.frequency);
                                    const isJCSBased = group.entries.some(e => e.jcs);
                                    const isSeverityBased = group.entries.some(e => e.severity);
                                    const hasLevels = isFrequencyBased || isJCSBased || isSeverityBased;

                                    const maxEventBarHeight = hasLevels ? 50 : 30;
                                    let maxLevel = 7;
                                    if (isJCSBased) maxLevel = 9;
                                    if (isSeverityBased) maxLevel = 3;

                                    svg += `<text x="${leftMargin - 8}" y="${yPos + maxEventBarHeight - 5}" text-anchor="end" font-size="10">${group.type}</text>`;
                                    svg += `<line x1="${leftMargin}" y1="${yPos + maxEventBarHeight}" x2="${leftMargin + graphWidth}" y2="${yPos + maxEventBarHeight}" stroke="#d1d5db" stroke-width="1"/>`;

                                    group.entries.forEach(entry => {
                                      const startDay = calcDaysFromOnset(entry.startDate);
                                      const endDay = entry.endDate ? calcDaysFromOnset(entry.endDate) : startDay;
                                      const x = leftMargin + ((startDay - minDay) / dayRange) * graphWidth;
                                      const w = Math.max(((endDay - startDay) / dayRange) * graphWidth, 8);

                                      // レベルとラベルを決定
                                      let level = maxLevel;
                                      let labelText = '';
                                      if (entry.frequency && pngFrequencyLevels[entry.frequency]) {
                                        level = pngFrequencyLevels[entry.frequency].level;
                                        labelText = pngFrequencyLevels[entry.frequency].label;
                                      } else if (entry.jcs && pngJcsLevels[entry.jcs]) {
                                        level = pngJcsLevels[entry.jcs].level;
                                        labelText = pngJcsLevels[entry.jcs].label;
                                      } else if (entry.severity && pngSeverityLevels[entry.severity]) {
                                        level = pngSeverityLevels[entry.severity].level;
                                        labelText = pngSeverityLevels[entry.severity].label;
                                      }

                                      // 高さを計算
                                      const h = hasLevels ? Math.max((level / maxLevel) * maxEventBarHeight, 12) : maxEventBarHeight;
                                      const y = yPos + maxEventBarHeight - h;

                                      svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" rx="2"/>`;
                                      if (w > 20 && h > 14 && labelText) {
                                        svg += `<text x="${x + w/2}" y="${y + h/2 + 3}" text-anchor="middle" font-size="8" fill="white">${labelText}</text>`;
                                      }
                                    });
                                    yPos += maxEventBarHeight + 15;
                                  });
                                }

                                // 検査データグラフ
                                if (hasLabData) {
                                  yPos += 20;
                                  svg += `<text x="${leftMargin}" y="${yPos}" font-size="11" font-weight="bold">【検査値】</text>`;
                                  yPos += 10;
                                  const chartHeight = 200;
                                  const chartTop = yPos;
                                  const chartBottom = yPos + chartHeight;
                                  svg += `<rect x="${leftMargin}" y="${chartTop}" width="${graphWidth}" height="${chartHeight}" fill="#f9fafb" stroke="#e5e7eb"/>`;
                                  for (let i = 1; i < 5; i++) {
                                    const gridY = chartTop + (chartHeight / 5) * i;
                                    svg += `<line x1="${leftMargin}" y1="${gridY}" x2="${leftMargin + graphWidth}" y2="${gridY}" stroke="#e5e7eb" stroke-dasharray="3,3"/>`;
                                  }
                                  selectedLabItemsForChart.forEach((itemName, itemIdx) => {
                                    const color = labPngColors[itemIdx % labPngColors.length];
                                    const dataPoints = [];
                                    labResults.forEach(lab => {
                                      const day = calcDaysFromOnset(lab.date);
                                      const labItem = lab.data?.find(d => d.item === itemName);
                                      if (day !== null && labItem && labItem.value !== '' && !isNaN(parseFloat(labItem.value))) {
                                        dataPoints.push({ day, value: parseFloat(labItem.value) });
                                      }
                                    });
                                    if (dataPoints.length === 0) return;
                                    dataPoints.sort((a, b) => a.day - b.day);
                                    const values = dataPoints.map(p => p.value);
                                    const minVal = Math.min(...values);
                                    const maxVal = Math.max(...values);
                                    const valRange = maxVal - minVal || 1;
                                    let pathD = '';
                                    dataPoints.forEach((point, idx) => {
                                      const x = leftMargin + ((point.day - minDay) / dayRange) * graphWidth;
                                      const y = chartBottom - ((point.value - minVal) / valRange) * (chartHeight - 20) - 10;
                                      pathD += idx === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
                                    });
                                    svg += `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2"/>`;
                                    dataPoints.forEach(point => {
                                      const x = leftMargin + ((point.day - minDay) / dayRange) * graphWidth;
                                      const y = chartBottom - ((point.value - minVal) / valRange) * (chartHeight - 20) - 10;
                                      svg += `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`;
                                    });
                                    const legendX = leftMargin + graphWidth + 10;
                                    const legendY = chartTop + 15 + itemIdx * 18;
                                    svg += `<line x1="${legendX}" y1="${legendY}" x2="${legendX + 15}" y2="${legendY}" stroke="${color}" stroke-width="2"/>`;
                                    svg += `<text x="${legendX + 20}" y="${legendY + 4}" font-size="9">${itemName}</text>`;
                                  });
                                  yPos = chartBottom + 10;
                                }

                                // X軸
                                yPos += 10;
                                svg += `<line x1="${leftMargin}" y1="${yPos}" x2="${leftMargin + graphWidth}" y2="${yPos}" stroke="#333" stroke-width="1"/>`;
                                for (let d = Math.ceil(minDay / 5) * 5; d <= maxDay; d += 5) {
                                  const x = leftMargin + ((d - minDay) / dayRange) * graphWidth;
                                  svg += `<line x1="${x}" y1="${yPos}" x2="${x}" y2="${yPos + 5}" stroke="#333" stroke-width="1"/>`;
                                  svg += `<text x="${x}" y="${yPos + 15}" text-anchor="middle" font-size="9">${d}</text>`;
                                }
                                svg += `<text x="${leftMargin + graphWidth/2}" y="${yPos + 30}" text-anchor="middle" font-size="10">Days from onset</text>`;
                                svg += '</svg>';

                                // SVGをPNGに変換
                                const canvas = document.createElement('canvas');
                                canvas.width = width * 2;
                                canvas.height = totalHeight * 2;
                                const ctx = canvas.getContext('2d');
                                ctx.scale(2, 2);
                                const img = new Image();
                                const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
                                const svgUrl = URL.createObjectURL(svgBlob);
                                img.onload = () => {
                                  ctx.fillStyle = 'white';
                                  ctx.fillRect(0, 0, width, totalHeight);
                                  ctx.drawImage(img, 0, 0);
                                  URL.revokeObjectURL(svgUrl);
                                  const pngUrl = canvas.toDataURL('image/png');
                                  const link = document.createElement('a');
                                  link.download = `${patient.displayId}_臨床経過.png`;
                                  link.href = pngUrl;
                                  link.click();
                                };
                                img.src = svgUrl;
                              };
                              generatePNG();
                            }}
                            style={{
                              padding: '10px 20px',
                              background: '#0ea5e9',
                              color: 'white',
                              border: 'none',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              fontSize: '13px',
                              fontWeight: '500',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px'
                            }}
                          >
                            <span>🖼️</span> 画像（PNG）
                          </button>
                          <button
                            onClick={downloadCSV}
                            style={{
                              padding: '10px 20px',
                              background: '#10b981',
                              color: 'white',
                              border: 'none',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              fontSize: '13px',
                              fontWeight: '500',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px'
                            }}
                          >
                            <span>📊</span> CSV
                          </button>
                          <button
                            onClick={downloadSVG}
                            style={{
                              padding: '10px 20px',
                              background: '#8b5cf6',
                              color: 'white',
                              border: 'none',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              fontSize: '13px',
                              fontWeight: '500',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px'
                            }}
                          >
                            <span>🎨</span> SVG（編集用）
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {!patient.onsetDate && (
                <div style={{
                  textAlign: 'center',
                  padding: '30px',
                  background: '#fef3c7',
                  borderRadius: '8px',
                  color: '#92400e'
                }}>
                  経時データ分析には発症日の設定が必要です。<br/>
                  基本情報で発症日を設定してください。
                </div>
              )}
            </div>
          )}
        </section>

        {/* 検査データセクション */}
        <section style={styles.section}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>検査データ</h2>
            <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap'}}>
              <button onClick={() => setShowAddLabModal(true)} style={styles.addLabButton}>
                <span>📷</span> 写真から追加
              </button>
              <button onClick={() => setShowExcelModal(true)} style={{...styles.addLabButton, background: '#e0f2fe', color: '#0369a1'}}>
                <span>📊</span> Excelから追加
              </button>
              {labResults.length > 0 && (
                <button onClick={deleteAllLabResults} style={{...styles.addLabButton, background: '#fef2f2', color: '#dc2626'}}>
                  <span>🗑️</span> 全削除
                </button>
              )}
            </div>
          </div>

          {labResults.length === 0 ? (
            <div style={styles.emptyLab}>
              <p>検査データはまだありません</p>
              <p style={{fontSize: '13px', marginTop: '8px'}}>
                「写真から追加」で検査結果を取り込めます
              </p>
            </div>
          ) : (
            <div style={styles.labTimeline}>
              {labResults.map((lab) => (
                <div key={lab.id} style={styles.labCard}>
                  <div style={styles.labCardHeader}>
                    <span style={styles.labDate}>{lab.date}</span>
                    <div style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
                      <span style={styles.labItemCount}>{lab.data?.length || 0} 項目</span>
                      <button
                        onClick={() => {
                          if (editingLabId === lab.id) {
                            setEditingLabId(null);
                            setEditLabItem({ item: '', value: '', unit: '' });
                          } else {
                            setEditingLabId(lab.id);
                          }
                        }}
                        style={{...styles.editButton, padding: '4px 12px', fontSize: '12px'}}
                      >
                        {editingLabId === lab.id ? '完了' : '編集'}
                      </button>
                      <button
                        onClick={() => deleteLabResult(lab.id)}
                        style={styles.deleteButton}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                  <div style={styles.labDataGrid}>
                    {lab.data?.map((item, idx) => (
                      <div key={idx} style={{...styles.labDataItem, position: 'relative'}}>
                        <span style={styles.labItemName}>{item.item}</span>
                        <span style={styles.labItemValue}>
                          {item.value}
                          <span style={styles.labItemUnit}> {item.unit}</span>
                        </span>
                        {editingLabId === lab.id && (
                          <button
                            onClick={() => removeItemFromLabResult(lab.id, idx)}
                            style={{
                              position: 'absolute',
                              top: '-6px',
                              right: '-6px',
                              width: '20px',
                              height: '20px',
                              borderRadius: '50%',
                              border: 'none',
                              background: '#ef4444',
                              color: 'white',
                              fontSize: '12px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* 編集モード：項目追加フォーム */}
                  {editingLabId === lab.id && (
                    <div style={{
                      marginTop: '16px',
                      padding: '16px',
                      background: '#f0fdf4',
                      borderRadius: '8px',
                      border: '1px solid #bbf7d0'
                    }}>
                      <p style={{fontSize: '13px', fontWeight: '500', marginBottom: '12px', color: '#166534'}}>
                        項目を追加
                      </p>
                      <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end'}}>
                        <div>
                          <label style={{fontSize: '11px', color: '#6b7280'}}>項目名</label>
                          <input
                            type="text"
                            value={editLabItem.item}
                            onChange={(e) => setEditLabItem({...editLabItem, item: e.target.value})}
                            style={{...styles.input, width: '120px', padding: '8px'}}
                            placeholder="例: CRP"
                          />
                        </div>
                        <div>
                          <label style={{fontSize: '11px', color: '#6b7280'}}>値</label>
                          <input
                            type="text"
                            value={editLabItem.value}
                            onChange={(e) => setEditLabItem({...editLabItem, value: e.target.value})}
                            style={{...styles.input, width: '100px', padding: '8px'}}
                            placeholder="例: 0.5"
                          />
                        </div>
                        <div>
                          <label style={{fontSize: '11px', color: '#6b7280'}}>単位</label>
                          <input
                            type="text"
                            value={editLabItem.unit}
                            onChange={(e) => setEditLabItem({...editLabItem, unit: e.target.value})}
                            style={{...styles.input, width: '80px', padding: '8px'}}
                            placeholder="例: mg/dL"
                          />
                        </div>
                        <button
                          onClick={() => addItemToLabResult(lab.id)}
                          disabled={!editLabItem.item || !editLabItem.value}
                          style={{
                            ...styles.saveButton,
                            padding: '8px 16px',
                            opacity: (!editLabItem.item || !editLabItem.value) ? 0.5 : 1
                          }}
                        >
                          追加
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* 臨床経過イベント追加モーダル */}
      {showAddEventModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '500px'}}>
            <h2 style={styles.modalTitle}>臨床経過イベントを追加</h2>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>イベント種類 *</label>
              <select
                value={newEvent.eventType}
                onChange={(e) => setNewEvent({...newEvent, eventType: e.target.value})}
                style={{...styles.input, width: '100%'}}
              >
                <option value="">選択してください</option>
                {availableEventTypes.map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>

            {newEvent.eventType === 'その他' && (
              <div style={{...styles.inputGroup, marginTop: '12px'}}>
                <label style={styles.inputLabel}>カスタムイベント名 *</label>
                <input
                  type="text"
                  value={newEvent.customEventType}
                  onChange={(e) => setNewEvent({...newEvent, customEventType: e.target.value})}
                  style={styles.input}
                  placeholder="例: 嚥下障害"
                />
              </div>
            )}

            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '16px'}}>
              <div style={styles.inputGroup}>
                <label style={styles.inputLabel}>開始日 *</label>
                <input
                  type="date"
                  value={newEvent.startDate}
                  onChange={(e) => setNewEvent({
                    ...newEvent,
                    startDate: e.target.value,
                    endDate: e.target.value // 終了日も同じ日に自動設定
                  })}
                  style={styles.input}
                />
              </div>
              <div style={styles.inputGroup}>
                <label style={styles.inputLabel}>
                  終了日{eventTypeConfig[newEvent.eventType]?.inputType === 'presence' ? '（該当なし）' : '（任意）'}
                </label>
                <input
                  type="date"
                  value={newEvent.endDate}
                  onChange={(e) => setNewEvent({...newEvent, endDate: e.target.value})}
                  style={styles.input}
                  disabled={eventTypeConfig[newEvent.eventType]?.inputType === 'presence'}
                />
              </div>
            </div>

            {/* JCSスケール入力（意識障害の場合） */}
            {eventTypeConfig[newEvent.eventType]?.inputType === 'jcs' && (
              <div style={{...styles.inputGroup, marginTop: '16px'}}>
                <label style={styles.inputLabel}>JCSスケール *</label>
                <select
                  value={newEvent.jcs}
                  onChange={(e) => setNewEvent({...newEvent, jcs: e.target.value})}
                  style={{...styles.input, width: '100%'}}
                >
                  <option value="">選択してください</option>
                  {jcsOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            )}

            {/* 頻度入力（てんかん発作、不随意運動の場合） */}
            {eventTypeConfig[newEvent.eventType]?.inputType === 'frequency' && (
              <div style={{...styles.inputGroup, marginTop: '16px'}}>
                <label style={styles.inputLabel}>頻度 *</label>
                <div style={{display: 'flex', flexWrap: 'wrap', gap: '8px'}}>
                  {frequencyOptions.map(opt => (
                    <label
                      key={opt.value}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: newEvent.frequency === opt.value ? '#dbeafe' : '#f8fafc',
                        border: newEvent.frequency === opt.value ? '2px solid #3b82f6' : '1px solid #e2e8f0'
                      }}
                    >
                      <input
                        type="radio"
                        name="frequency"
                        value={opt.value}
                        checked={newEvent.frequency === opt.value}
                        onChange={(e) => setNewEvent({...newEvent, frequency: e.target.value})}
                        style={{display: 'none'}}
                      />
                      <span style={{fontSize: '13px'}}>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* 有無入力（頭痛、髄膜刺激症状、人工呼吸器、ICUの場合） */}
            {eventTypeConfig[newEvent.eventType]?.inputType === 'presence' && (
              <div style={{...styles.inputGroup, marginTop: '16px'}}>
                <label style={styles.inputLabel}>有無 *</label>
                <div style={{display: 'flex', gap: '10px'}}>
                  {['あり', 'なし'].map(val => (
                    <label
                      key={val}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '10px 20px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: newEvent.presence === val ? (val === 'あり' ? '#fee2e2' : '#dcfce7') : '#f8fafc',
                        border: newEvent.presence === val ? `2px solid ${val === 'あり' ? '#ef4444' : '#22c55e'}` : '1px solid #e2e8f0'
                      }}
                    >
                      <input
                        type="radio"
                        name="presence"
                        value={val}
                        checked={newEvent.presence === val}
                        onChange={(e) => setNewEvent({...newEvent, presence: e.target.value})}
                        style={{display: 'none'}}
                      />
                      <span style={{fontSize: '14px', fontWeight: '500'}}>{val}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* 重症度入力（その他のイベントの場合） */}
            {(eventTypeConfig[newEvent.eventType]?.inputType === 'severity' || newEvent.eventType === 'その他') && (
              <div style={{...styles.inputGroup, marginTop: '16px'}}>
                <label style={styles.inputLabel}>重症度（任意）</label>
                <div style={{display: 'flex', gap: '10px'}}>
                  {['軽症', '中等症', '重症'].map(sev => (
                    <label
                      key={sev}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        background: newEvent.severity === sev ? '#fef3c7' : '#f8fafc',
                        border: newEvent.severity === sev ? '2px solid #f59e0b' : '1px solid #e2e8f0'
                      }}
                    >
                      <input
                        type="radio"
                        name="severity"
                        value={sev}
                        checked={newEvent.severity === sev}
                        onChange={(e) => setNewEvent({...newEvent, severity: e.target.value})}
                        style={{display: 'none'}}
                      />
                      <span style={{fontSize: '13px'}}>{sev}</span>
                    </label>
                  ))}
                  {newEvent.severity && (
                    <button
                      onClick={() => setNewEvent({...newEvent, severity: ''})}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#6b7280',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      クリア
                    </button>
                  )}
                </div>
              </div>
            )}

            <div style={{...styles.inputGroup, marginTop: '16px'}}>
              <label style={styles.inputLabel}>メモ（任意）</label>
              <textarea
                value={newEvent.note}
                onChange={(e) => setNewEvent({...newEvent, note: e.target.value})}
                style={{...styles.input, minHeight: '80px', resize: 'vertical'}}
                placeholder="詳細な経過や治療内容など"
              />
            </div>

            <div style={styles.modalActions}>
              <button
                onClick={() => {
                  setShowAddEventModal(false);
                  setNewEvent({
                    eventType: '',
                    customEventType: '',
                    startDate: '',
                    endDate: '',
                    severity: '',
                    jcs: '',
                    frequency: '',
                    presence: '',
                    note: ''
                  });
                }}
                style={styles.cancelButton}
              >
                キャンセル
              </button>
              <button
                onClick={addClinicalEvent}
                disabled={
                  !newEvent.eventType ||
                  !newEvent.startDate ||
                  (newEvent.eventType === 'その他' && !newEvent.customEventType) ||
                  (eventTypeConfig[newEvent.eventType]?.inputType === 'jcs' && !newEvent.jcs) ||
                  (eventTypeConfig[newEvent.eventType]?.inputType === 'frequency' && !newEvent.frequency) ||
                  (eventTypeConfig[newEvent.eventType]?.inputType === 'presence' && !newEvent.presence)
                }
                style={{
                  ...styles.primaryButton,
                  backgroundColor: '#f59e0b',
                  opacity: (!newEvent.eventType || !newEvent.startDate) ? 0.5 : 1
                }}
              >
                追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 治療薬追加モーダル */}
      {showAddTreatmentModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '550px'}}>
            <h2 style={styles.modalTitle}>治療薬を追加</h2>

            {/* 親カテゴリ（領域）選択 */}
            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>領域 *</label>
              <select
                value={newTreatment.parentCategory}
                onChange={(e) => {
                  setNewTreatment({
                    ...newTreatment,
                    parentCategory: e.target.value,
                    category: '',
                    medicationName: '',
                    customMedication: '',
                    dosageUnit: ''
                  });
                }}
                style={{...styles.input, width: '100%'}}
              >
                <option value="">選択してください</option>
                {Object.keys(treatmentParentCategories).map(parent => (
                  <option key={parent} value={parent}>{parent}</option>
                ))}
              </select>
            </div>

            {/* サブカテゴリ選択 */}
            {newTreatment.parentCategory && (
              <div style={{...styles.inputGroup, marginTop: '12px'}}>
                <label style={styles.inputLabel}>カテゴリ *</label>
                <select
                  value={newTreatment.category}
                  onChange={(e) => {
                    const category = e.target.value;
                    const defaultUnit = treatmentCategories[category]?.defaultUnit || '';
                    setNewTreatment({
                      ...newTreatment,
                      category: category,
                      medicationName: '',
                      customMedication: '',
                      dosageUnit: defaultUnit
                    });
                  }}
                  style={{...styles.input, width: '100%'}}
                >
                  <option value="">選択してください</option>
                  {treatmentParentCategories[newTreatment.parentCategory]?.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
            )}

            {newTreatment.category && (
              <div style={{...styles.inputGroup, marginTop: '12px'}}>
                <label style={styles.inputLabel}>薬剤名 *</label>
                {treatmentCategories[newTreatment.category]?.medications.length > 0 ? (
                  <select
                    value={newTreatment.medicationName}
                    onChange={(e) => setNewTreatment({...newTreatment, medicationName: e.target.value})}
                    style={{...styles.input, width: '100%'}}
                  >
                    <option value="">選択してください</option>
                    {treatmentCategories[newTreatment.category].medications.map(med => (
                      <option key={med} value={med}>{med}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={newTreatment.customMedication}
                    onChange={(e) => setNewTreatment({...newTreatment, customMedication: e.target.value})}
                    style={styles.input}
                    placeholder="薬剤名を入力"
                  />
                )}
              </div>
            )}

            {newTreatment.medicationName === 'その他' && (
              <div style={{...styles.inputGroup, marginTop: '12px'}}>
                <label style={styles.inputLabel}>薬剤名（その他） *</label>
                <input
                  type="text"
                  value={newTreatment.customMedication}
                  onChange={(e) => setNewTreatment({...newTreatment, customMedication: e.target.value})}
                  style={styles.input}
                  placeholder="薬剤名を入力"
                />
              </div>
            )}

            {/* 用量フィールド（血漿交換など noDosage カテゴリでは非表示） */}
            {!treatmentCategories[newTreatment.category]?.noDosage && (
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '16px'}}>
                <div style={styles.inputGroup}>
                  <label style={styles.inputLabel}>投与量</label>
                  <input
                    type="text"
                    value={newTreatment.dosage}
                    onChange={(e) => setNewTreatment({...newTreatment, dosage: e.target.value})}
                    style={styles.input}
                    placeholder="例: 500"
                  />
                </div>
                <div style={styles.inputGroup}>
                  <label style={styles.inputLabel}>単位</label>
                  <select
                    value={newTreatment.dosageUnit}
                    onChange={(e) => setNewTreatment({...newTreatment, dosageUnit: e.target.value})}
                    style={{...styles.input, width: '100%'}}
                  >
                    <option value="">選択してください</option>
                    {dosageUnits.map(unit => (
                      <option key={unit} value={unit}>{unit}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '16px'}}>
              <div style={styles.inputGroup}>
                <label style={styles.inputLabel}>開始日 *</label>
                <input
                  type="date"
                  value={newTreatment.startDate}
                  onChange={(e) => setNewTreatment({
                    ...newTreatment,
                    startDate: e.target.value,
                    endDate: e.target.value // 終了日も同じ日に自動設定
                  })}
                  style={styles.input}
                />
              </div>
              <div style={styles.inputGroup}>
                <label style={styles.inputLabel}>終了日（任意）</label>
                <input
                  type="date"
                  value={newTreatment.endDate}
                  onChange={(e) => setNewTreatment({...newTreatment, endDate: e.target.value})}
                  style={styles.input}
                />
              </div>
            </div>

            <div style={{...styles.inputGroup, marginTop: '16px'}}>
              <label style={styles.inputLabel}>メモ（任意）</label>
              <textarea
                value={newTreatment.note}
                onChange={(e) => setNewTreatment({...newTreatment, note: e.target.value})}
                style={{...styles.input, minHeight: '60px', resize: 'vertical'}}
                placeholder="投与方法、効果、副作用など"
              />
            </div>

            <div style={styles.modalActions}>
              <button
                onClick={() => {
                  setShowAddTreatmentModal(false);
                  setNewTreatment({
                    category: '',
                    medicationName: '',
                    customMedication: '',
                    dosage: '',
                    dosageUnit: '',
                    startDate: '',
                    endDate: '',
                    note: ''
                  });
                }}
                style={styles.cancelButton}
              >
                キャンセル
              </button>
              <button
                onClick={addTreatment}
                disabled={
                  !newTreatment.category ||
                  !newTreatment.startDate ||
                  (!newTreatment.medicationName && !newTreatment.customMedication) ||
                  (newTreatment.medicationName === 'その他' && !newTreatment.customMedication)
                }
                style={{
                  ...styles.primaryButton,
                  backgroundColor: '#059669',
                  opacity: (!newTreatment.category || !newTreatment.startDate) ? 0.5 : 1
                }}
              >
                追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 臨床経過タイムラインモーダル */}
      {showClinicalTimeline && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto'}}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px'}}>
              <h2 style={styles.modalTitle}>臨床経過タイムライン - {patient?.displayId}</h2>
              <button
                onClick={() => setShowClinicalTimeline(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '24px',
                  cursor: 'pointer',
                  color: '#6b7280'
                }}
              >
                ×
              </button>
            </div>

            <div ref={timelineRef} style={{background: 'white', padding: '20px'}}>
              {/* 患者情報 */}
              <div style={{
                marginBottom: '24px',
                padding: '16px',
                background: '#f9fafb',
                borderRadius: '8px',
                display: 'flex',
                gap: '24px',
                flexWrap: 'wrap'
              }}>
                <div><strong>患者ID:</strong> {patient?.displayId}</div>
                <div><strong>診断:</strong> {patient?.diagnosis}</div>
                <div><strong>群:</strong> {patient?.group || '未設定'}</div>
                <div><strong>発症日:</strong> {patient?.onsetDate || '未設定'}</div>
              </div>

              {(() => {
                if (!patient.onsetDate) {
                  return <p style={{color: '#6b7280'}}>発症日が設定されていないため、タイムラインを表示できません。</p>;
                }

                // 全データのDay範囲を計算
                const allDays = [
                  ...treatments.flatMap(t => [
                    calcDaysFromOnset(t.startDate),
                    t.endDate ? calcDaysFromOnset(t.endDate) : calcDaysFromOnset(t.startDate)
                  ]),
                  ...clinicalEvents.flatMap(e => [
                    calcDaysFromOnset(e.startDate),
                    e.endDate ? calcDaysFromOnset(e.endDate) : calcDaysFromOnset(e.startDate)
                  ])
                ].filter(d => d !== null);

                if (allDays.length === 0) {
                  return <p style={{color: '#6b7280'}}>表示するデータがありません。</p>;
                }

                const minDay = Math.min(...allDays, 0);
                const maxDay = Math.max(...allDays) + 3;
                const dayRange = maxDay - minDay || 1;

                // カテゴリの色
                const treatmentColors = {
                  '抗てんかん薬': '#f59e0b',
                  'ステロイド': '#ec4899',
                  '免疫グロブリン': '#3b82f6',
                  '血漿交換': '#6366f1',
                  '免疫抑制剤': '#8b5cf6',
                  '抗ウイルス薬': '#14b8a6',
                  '抗菌薬': '#eab308',
                  '抗浮腫薬': '#0ea5e9',
                  'その他': '#6b7280'
                };

                const eventColors = {
                  '意識障害': '#dc2626',
                  'てんかん発作': '#ea580c',
                  '不随意運動': '#d97706',
                  '麻痺': '#ca8a04',
                  '感覚障害': '#65a30d',
                  '失語': '#16a34a',
                  '認知機能障害': '#0d9488',
                  '精神症状': '#0891b2',
                  '発熱': '#ef4444',
                  '頭痛': '#f97316',
                  '髄膜刺激症状': '#84cc16',
                  '人工呼吸器管理': '#7c3aed',
                  'ICU入室': '#9333ea'
                };

                return (
                  <>
                    {/* X軸（Day表示）- 経過が長い場合は間隔を自動調整 */}
                    <div style={{marginLeft: '180px', marginBottom: '8px', position: 'relative', height: '24px', borderBottom: '1px solid #e5e7eb'}}>
                      {(() => {
                        // 表示間隔を自動調整（ラベルが被らないように）
                        let step = 5;
                        if (dayRange > 50) step = 10;
                        if (dayRange > 100) step = 20;
                        if (dayRange > 200) step = 30;
                        if (dayRange > 500) step = 50;
                        if (dayRange > 1000) step = 100;

                        const labels = [];
                        const firstDay = Math.ceil(minDay / step) * step;
                        for (let day = firstDay; day <= maxDay; day += step) {
                          labels.push(day);
                        }
                        if (labels[0] !== minDay && minDay >= 0) labels.unshift(minDay);

                        return labels.map((day, i) => {
                          const leftPercent = ((day - minDay) / dayRange) * 100;
                          return (
                            <div key={i} style={{position: 'absolute', left: `${leftPercent}%`, transform: 'translateX(-50%)'}}>
                              <span style={{fontSize: '11px', color: '#374151', fontWeight: '500'}}>Day {day}</span>
                              <div style={{width: '1px', height: '8px', background: '#d1d5db', margin: '0 auto'}} />
                            </div>
                          );
                        });
                      })()}
                    </div>

                    {/* 臨床症状セクション（同じ症状は横並び、頻度/重症度で高さが変化） */}
                    {clinicalEvents.length > 0 && (
                      <>
                        <div style={{fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '8px', marginTop: '16px'}}>
                          臨床症状
                        </div>
                        <div style={{display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '20px'}}>
                          {(() => {
                            // 頻度レベル
                            const frequencyLevels = {
                              'hourly': { level: 7, label: '毎時' },
                              'several_daily': { level: 6, label: '数回/日' },
                              'daily': { level: 5, label: '毎日' },
                              'several_weekly': { level: 4, label: '数回/週' },
                              'weekly': { level: 3, label: '週1' },
                              'monthly': { level: 2, label: '月1' },
                              'rare': { level: 1, label: '稀' }
                            };
                            // JCSレベル
                            const jcsLevels = {
                              '0': { level: 0, label: '清明' },
                              'I-1': { level: 1, label: 'I-1' },
                              'I-2': { level: 2, label: 'I-2' },
                              'I-3': { level: 3, label: 'I-3' },
                              'II-10': { level: 4, label: 'II-10' },
                              'II-20': { level: 5, label: 'II-20' },
                              'II-30': { level: 6, label: 'II-30' },
                              'III-100': { level: 7, label: 'III-100' },
                              'III-200': { level: 8, label: 'III-200' },
                              'III-300': { level: 9, label: 'III-300' }
                            };
                            // 重症度レベル
                            const severityLevels = {
                              '軽度': { level: 1, label: '軽度' },
                              '中等度': { level: 2, label: '中等度' },
                              '重度': { level: 3, label: '重度' }
                            };

                            // イベントタイプごとにグループ化
                            const groups = {};
                            clinicalEvents.forEach(e => {
                              if (!groups[e.eventType]) {
                                groups[e.eventType] = { type: e.eventType, entries: [] };
                              }
                              groups[e.eventType].entries.push(e);
                            });
                            Object.values(groups).forEach(g => g.entries.sort((a, b) => new Date(a.startDate) - new Date(b.startDate)));

                            return Object.values(groups).map((group, gIdx) => {
                              const color = eventColors[group.type] || '#6b7280';

                              // レベルベースかどうか判定
                              const isFrequencyBased = group.entries.some(e => e.frequency);
                              const isJCSBased = group.entries.some(e => e.jcs);
                              const isSeverityBased = group.entries.some(e => e.severity);
                              const hasLevels = isFrequencyBased || isJCSBased || isSeverityBased;

                              const maxBarHeight = hasLevels ? 50 : 26;
                              let maxLevel = 7;
                              if (isJCSBased) maxLevel = 9;
                              if (isSeverityBased) maxLevel = 3;

                              return (
                                <div key={gIdx} style={{display: 'flex', alignItems: hasLevels ? 'flex-end' : 'center', height: `${maxBarHeight + 8}px`}}>
                                  <div style={{
                                    width: '180px',
                                    flexShrink: 0,
                                    fontSize: '11px',
                                    color: '#374151',
                                    paddingRight: '12px',
                                    textAlign: 'right',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'flex-end',
                                    gap: '6px',
                                    paddingBottom: hasLevels ? '4px' : '0'
                                  }}>
                                    <span style={{
                                      width: '8px',
                                      height: '8px',
                                      borderRadius: '50%',
                                      background: color,
                                      flexShrink: 0
                                    }} />
                                    <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                                      {group.type}
                                    </span>
                                  </div>

                                  <div style={{
                                    flex: 1,
                                    position: 'relative',
                                    height: `${maxBarHeight}px`,
                                    background: '#fafafa'
                                  }}>
                                    {group.entries.map((entry, eIdx) => {
                                      const startDay = calcDaysFromOnset(entry.startDate);
                                      const endDay = entry.endDate ? calcDaysFromOnset(entry.endDate) : startDay;
                                      const leftPercent = ((startDay - minDay) / dayRange) * 100;
                                      const widthPercent = Math.max(((endDay - startDay) / dayRange) * 100, 2);

                                      // レベルとラベルを決定
                                      let level = maxLevel;
                                      let labelText = '';
                                      if (entry.frequency && frequencyLevels[entry.frequency]) {
                                        level = frequencyLevels[entry.frequency].level;
                                        labelText = frequencyLevels[entry.frequency].label;
                                      } else if (entry.jcs && jcsLevels[entry.jcs]) {
                                        level = jcsLevels[entry.jcs].level;
                                        labelText = jcsLevels[entry.jcs].label;
                                      } else if (entry.severity && severityLevels[entry.severity]) {
                                        level = severityLevels[entry.severity].level;
                                        labelText = severityLevels[entry.severity].label;
                                      } else if (entry.presence) {
                                        labelText = entry.presence;
                                      }

                                      const barHeight = hasLevels
                                        ? Math.max((level / maxLevel) * maxBarHeight, 14)
                                        : maxBarHeight - 8;

                                      return (
                                        <div
                                          key={eIdx}
                                          style={{
                                            position: 'absolute',
                                            left: `${leftPercent}%`,
                                            width: `${widthPercent}%`,
                                            height: `${barHeight}px`,
                                            bottom: 0,
                                            background: color,
                                            borderRadius: '2px 2px 0 0',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            opacity: 0.85
                                          }}
                                          title={`${group.type}: Day ${startDay}〜${endDay}${labelText ? ` (${labelText})` : ''}`}
                                        >
                                          {widthPercent > 4 && barHeight > 14 && labelText && (
                                            <span style={{fontSize: '9px', color: 'white', fontWeight: '600'}}>
                                              {labelText}
                                            </span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </>
                    )}

                    {/* 治療セクション */}
                    {treatments.length > 0 && (
                      <>
                        <div style={{fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '8px'}}>
                          治療
                        </div>
                        <div style={{display: 'flex', flexDirection: 'column', gap: '4px'}}>
                          {treatments.sort((a, b) => new Date(a.startDate) - new Date(b.startDate)).map((t, idx) => {
                            const startDay = calcDaysFromOnset(t.startDate);
                            const endDay = t.endDate ? calcDaysFromOnset(t.endDate) : startDay;
                            const isSingleDay = startDay === endDay;
                            const color = treatmentColors[t.category] || treatmentColors['その他'];

                            const leftPercent = ((startDay - minDay) / dayRange) * 100;
                            const widthPercent = isSingleDay ? 0 : ((endDay - startDay) / dayRange) * 100;

                            return (
                              <div key={idx} style={{display: 'flex', alignItems: 'center', height: '26px'}}>
                                <div style={{
                                  width: '180px',
                                  flexShrink: 0,
                                  fontSize: '11px',
                                  color: '#374151',
                                  paddingRight: '12px',
                                  textAlign: 'right',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }} title={t.medicationName}>
                                  {t.medicationName}
                                </div>

                                <div style={{
                                  flex: 1,
                                  position: 'relative',
                                  height: '100%',
                                  background: '#fafafa'
                                }}>
                                  {isSingleDay ? (
                                    <div
                                      style={{
                                        position: 'absolute',
                                        left: `${leftPercent}%`,
                                        top: '50%',
                                        transform: 'translate(-50%, -50%)',
                                        width: 0,
                                        height: 0,
                                        borderLeft: '8px solid transparent',
                                        borderRight: '8px solid transparent',
                                        borderBottom: `14px solid ${color}`
                                      }}
                                      title={`${t.medicationName}: Day ${startDay}${t.dosage ? ` (${t.dosage}${t.dosageUnit || ''})` : ''}`}
                                    />
                                  ) : (
                                    <div
                                      style={{
                                        position: 'absolute',
                                        left: `${leftPercent}%`,
                                        width: `${Math.max(widthPercent, 0.5)}%`,
                                        height: '18px',
                                        top: '50%',
                                        transform: 'translateY(-50%)',
                                        background: color,
                                        borderRadius: '4px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center'
                                      }}
                                      title={`${t.medicationName}: Day ${startDay}〜${endDay}${t.dosage ? ` (${t.dosage}${t.dosageUnit || ''})` : ''}`}
                                    >
                                      {t.dosage && widthPercent > 5 && (
                                        <span style={{fontSize: '9px', color: 'white', fontWeight: '500'}}>
                                          {t.dosage}{t.dosageUnit ? t.dosageUnit.replace('/日', '') : ''}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}

                    {/* 凡例 */}
                    <div style={{marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e5e7eb'}}>
                      <div style={{fontSize: '12px', fontWeight: '600', color: '#374151', marginBottom: '8px'}}>凡例</div>
                      <div style={{display: 'flex', flexWrap: 'wrap', gap: '16px'}}>
                        <div>
                          <div style={{fontSize: '10px', color: '#6b7280', marginBottom: '4px'}}>症状</div>
                          <div style={{display: 'flex', flexWrap: 'wrap', gap: '8px'}}>
                            {Object.entries(eventColors).map(([name, color]) => {
                              const hasEvent = clinicalEvents.some(e => e.eventType === name);
                              if (!hasEvent) return null;
                              return (
                                <div key={name} style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                                  <div style={{width: '10px', height: '10px', borderRadius: '50%', background: color}} />
                                  <span style={{fontSize: '10px', color: '#6b7280'}}>{name}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div>
                          <div style={{fontSize: '10px', color: '#6b7280', marginBottom: '4px'}}>治療</div>
                          <div style={{display: 'flex', flexWrap: 'wrap', gap: '8px'}}>
                            {Object.entries(treatmentColors).map(([name, color]) => {
                              const hasTreat = treatments.some(t => t.category === name);
                              if (!hasTreat) return null;
                              return (
                                <div key={name} style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                                  <div style={{width: '12px', height: '8px', borderRadius: '2px', background: color}} />
                                  <span style={{fontSize: '10px', color: '#6b7280'}}>{name}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                          <div style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                            <div style={{
                              width: 0,
                              height: 0,
                              borderLeft: '6px solid transparent',
                              borderRight: '6px solid transparent',
                              borderBottom: '10px solid #6b7280'
                            }} />
                            <span style={{fontSize: '10px', color: '#6b7280'}}>単発治療</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>

            <div style={{display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px'}}>
              <button
                onClick={() => setShowClinicalTimeline(false)}
                style={styles.cancelButton}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 検査データ追加モーダル */}
      {showAddLabModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '620px'}}>
            <h2 style={styles.modalTitle}>検査データを追加</h2>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>検査日 *</label>
              <input
                type="date"
                value={labDate}
                onChange={(e) => setLabDate(e.target.value)}
                style={styles.input}
              />
            </div>

            <div style={styles.uploadSection}>
              <label style={styles.inputLabel}>検査結果の写真</label>
              <div style={styles.uploadArea}>
                {!selectedImage ? (
                  <label style={styles.uploadLabel}>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleImageUpload}
                      style={{ display: 'none' }}
                    />
                    <div 
                      style={styles.uploadContent}
                      onMouseOver={(e) => e.currentTarget.style.borderColor = '#94a3b8'}
                      onMouseOut={(e) => e.currentTarget.style.borderColor = '#cbd5e1'}
                    >
                      <span style={styles.uploadIcon}>📷</span>
                      <span style={{fontWeight: '500', color: '#475569'}}>
                        クリックして画像を選択
                      </span>
                      <span style={styles.uploadHint}>
                        ※ 個人情報（氏名・ID等）は自動的に除外されます<br/>
                        検査値のみが抽出されます
                      </span>
                    </div>
                  </label>
                ) : (
                  <div style={styles.previewContainer}>
                    <img src={selectedImage} alt="Preview" style={styles.previewImage} />
                  </div>
                )}
              </div>
            </div>

            {isProcessing && (
              <div style={styles.processingState}>
                <div style={styles.progressBar}>
                  <div style={{...styles.progressFill, width: `${ocrProgress}%`}} />
                </div>
                <span style={{fontWeight: '500', color: '#1d4ed8'}}>
                  検査値を読み取り中... {ocrProgress}%
                </span>
                <span style={styles.processingNote}>
                  個人情報を除外し、検査値のみ抽出しています
                </span>
              </div>
            )}

            {ocrResults !== null && !isProcessing && (
              <div style={styles.ocrResults}>
                <h3 style={styles.ocrTitle}>
                  ✓ 抽出された検査値 ({ocrResults.length} 項目)
                </h3>
                <p style={styles.ocrNote}>
                  🔒 個人情報（氏名・ID・住所等）は除外済み
                </p>
                {ocrResults.length > 0 ? (
                  <div style={styles.ocrGrid}>
                    {ocrResults.map((item, idx) => (
                      <div key={idx} style={styles.ocrItem}>
                        <span style={styles.ocrItemName}>{item.item}</span>
                        <span style={styles.ocrItemValue}>{item.value} {item.unit}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{fontSize: '13px', color: '#64748b'}}>
                    検査値が検出されませんでした。下の手動入力をご利用ください。
                  </p>
                )}
              </div>
            )}

            {/* 手動入力セクション */}
            <div style={styles.manualEntrySection}>
              <div style={styles.manualEntryTitle}>検査値を手動で追加</div>
              <div style={styles.manualEntryRow}>
                <input
                  type="text"
                  placeholder="項目名 (例: CRP)"
                  value={manualItem.item}
                  onChange={(e) => setManualItem({...manualItem, item: e.target.value})}
                  style={{...styles.manualInput, flex: 1}}
                />
                <input
                  type="number"
                  placeholder="値"
                  value={manualItem.value}
                  onChange={(e) => setManualItem({...manualItem, value: e.target.value})}
                  style={{...styles.manualInput, width: '80px'}}
                />
                <input
                  type="text"
                  placeholder="単位"
                  value={manualItem.unit}
                  onChange={(e) => setManualItem({...manualItem, unit: e.target.value})}
                  style={{...styles.manualInput, width: '80px'}}
                />
                <button onClick={addManualItem} style={styles.addItemButton}>
                  追加
                </button>
              </div>
            </div>

            <div style={styles.modalActions}>
              <button
                onClick={() => {
                  setShowAddLabModal(false);
                  setOcrResults(null);
                  setSelectedImage(null);
                  setLabDate('');
                }}
                style={styles.cancelButton}
              >
                キャンセル
              </button>
              <button
                onClick={saveLabResults}
                style={{
                  ...styles.primaryButton,
                  opacity: (!ocrResults || ocrResults.length === 0 || !labDate) ? 0.5 : 1
                }}
                disabled={!ocrResults || ocrResults.length === 0 || !labDate}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Excelインポートモーダル */}
      {showExcelModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '800px'}}>
            <h2 style={styles.modalTitle}>Excelから検査データをインポート</h2>

            {!excelData ? (
              <>
                <div style={{marginBottom: '16px', textAlign: 'center'}}>
                  <button
                    onClick={downloadLabDataSample}
                    style={{
                      padding: '10px 16px',
                      background: '#f0fdf4',
                      color: '#047857',
                      border: '1px solid #86efac',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <span>📄</span> サンプルExcelをダウンロード
                  </button>
                  <p style={{fontSize: '12px', color: '#6b7280', marginTop: '8px'}}>
                    フォーマットを確認してからデータを作成できます
                  </p>
                </div>
                <div style={styles.uploadArea}>
                  <label style={styles.uploadLabel}>
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={handleExcelUpload}
                      style={{ display: 'none' }}
                    />
                    <div style={styles.uploadContent}>
                      <span style={styles.uploadIcon}>📊</span>
                      <span style={{fontWeight: '500', color: '#475569'}}>
                      クリックしてExcelファイルを選択
                    </span>
                    <span style={styles.uploadHint}>
                      .xlsx または .xls ファイルに対応
                    </span>
                  </div>
                </label>
              </div>
              </>
            ) : (
              <>
                {/* シート選択 */}
                <div style={{marginBottom: '20px'}}>
                  <label style={styles.inputLabel}>シートを選択</label>
                  <select
                    value={selectedSheet}
                    onChange={(e) => handleSheetChange(e.target.value)}
                    style={{...styles.input, width: '100%', marginTop: '8px'}}
                  >
                    {excelSheets.map(sheet => (
                      <option key={sheet} value={sheet}>{sheet}</option>
                    ))}
                  </select>
                </div>

                {/* プレビュー */}
                {parsedExcelData.length > 0 ? (
                  <div style={{maxHeight: '400px', overflowY: 'auto'}}>
                    <p style={{fontSize: '14px', color: '#059669', marginBottom: '16px', fontWeight: '600'}}>
                      ✓ {parsedExcelData.length}日分のデータが見つかりました
                    </p>
                    {parsedExcelData.map((dayData, idx) => (
                      <div key={idx} style={{...styles.labCard, marginBottom: '12px'}}>
                        <div style={styles.labCardHeader}>
                          <span style={styles.labDate}>
                            {dayData.date} ({dayData.day})
                            {dayData.specimen && <span style={{marginLeft: '8px', fontSize: '12px', color: '#6b7280'}}>- {dayData.specimen}</span>}
                          </span>
                          <span style={styles.labItemCount}>{dayData.data.length} 項目</span>
                        </div>
                        <div style={styles.labDataGrid}>
                          {dayData.data.slice(0, 8).map((item, i) => (
                            <div key={i} style={styles.labDataItem}>
                              <span style={styles.labItemName}>{item.item}</span>
                              <span style={styles.labItemValue}>
                                {item.value}
                                <span style={styles.labItemUnit}> {item.unit}</span>
                              </span>
                            </div>
                          ))}
                          {dayData.data.length > 8 && (
                            <div style={{...styles.labDataItem, background: '#f1f5f9', justifyContent: 'center'}}>
                              <span style={{color: '#64748b', fontSize: '12px'}}>
                                +{dayData.data.length - 8} 項目
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{color: '#64748b', textAlign: 'center', padding: '40px'}}>
                    このシートには検査データが見つかりませんでした
                  </p>
                )}
              </>
            )}

            <div style={styles.modalActions}>
              <button
                onClick={() => {
                  setShowExcelModal(false);
                  setExcelData(null);
                  setExcelSheets([]);
                  setParsedExcelData([]);
                }}
                style={styles.cancelButton}
              >
                キャンセル
              </button>
              {excelData && parsedExcelData.length > 0 && (
                <button
                  onClick={importExcelData}
                  style={{...styles.primaryButton, opacity: isImporting ? 0.7 : 1}}
                  disabled={isImporting}
                >
                  {isImporting ? 'インポート中...' : `${parsedExcelData.length}日分をインポート`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// メインアプリケーション
// ============================================================
function App() {
  const { user } = useAuth();
  const [selectedPatient, setSelectedPatient] = useState(null);

  if (!user) {
    return <LoginView />;
  }

  if (selectedPatient) {
    return (
      <PatientDetailView
        patient={selectedPatient}
        onBack={() => setSelectedPatient(null)}
      />
    );
  }

  return <PatientsListView onSelectPatient={setSelectedPatient} />;
}

// AuthProviderでラップしてエクスポート
export default function AppWithAuth() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
