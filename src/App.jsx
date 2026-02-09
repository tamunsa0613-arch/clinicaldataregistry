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
  where,
  limit
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
// 組織コンテキスト（マルチテナント対応）
// ============================================================
const OrganizationContext = createContext();

function OrganizationProvider({ children }) {
  const { user } = useAuth();
  const [organizations, setOrganizations] = useState([]);
  const [currentOrg, setCurrentOrg] = useState(null);
  const [orgLoading, setOrgLoading] = useState(true);
  const [isSystemAdmin, setIsSystemAdmin] = useState(false);

  useEffect(() => {
    if (!user) {
      setOrganizations([]);
      setCurrentOrg(null);
      setOrgLoading(false);
      return;
    }

    // システム管理者かどうかをチェック
    const checkSystemAdmin = async () => {
      try {
        const sysAdminDoc = await getDoc(doc(db, 'config', 'systemAdmin'));
        if (sysAdminDoc.exists()) {
          const emails = sysAdminDoc.data().emails || [];
          setIsSystemAdmin(emails.includes(user.email));
        }
      } catch (err) {
        console.error('Error checking system admin:', err);
      }
    };
    checkSystemAdmin();

    // ユーザーの組織メンバーシップを監視
    const q = query(
      collection(db, 'organizationMembers'),
      where('uid', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      try {
        const memberships = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));

        if (memberships.length === 0) {
          // 組織に所属していない場合は旧システム（個人データ）を使用
          setOrganizations([]);
          setCurrentOrg(null);
          setOrgLoading(false);
          return;
        }

        // 各メンバーシップの組織詳細を取得
        const orgsWithDetails = await Promise.all(
          memberships.map(async (membership) => {
            try {
              const orgDoc = await getDoc(doc(db, 'organizations', membership.orgId));
              if (orgDoc.exists()) {
                return {
                  id: membership.orgId,
                  role: membership.role,
                  ...orgDoc.data()
                };
              }
              return null;
            } catch (err) {
              console.error('Error fetching org:', err);
              return null;
            }
          })
        );

        const validOrgs = orgsWithDetails.filter(o => o !== null);
        setOrganizations(validOrgs);

        // デフォルト組織を設定
        if (validOrgs.length > 0 && !currentOrg) {
          try {
            const userDoc = await getDoc(doc(db, 'users', user.uid));
            const defaultOrgId = userDoc.exists() ? userDoc.data()?.defaultOrgId : null;
            const defaultOrg = validOrgs.find(o => o.id === defaultOrgId);
            setCurrentOrg(defaultOrg || validOrgs[0]);
          } catch (err) {
            setCurrentOrg(validOrgs[0]);
          }
        }

        setOrgLoading(false);
      } catch (err) {
        console.error('Error loading organizations:', err);
        setOrgLoading(false);
      }
    });

    return () => unsubscribe();
  }, [user]);

  // 組織を切り替え
  const switchOrganization = async (orgId) => {
    const org = organizations.find(o => o.id === orgId);
    if (org) {
      setCurrentOrg(org);
      // ユーザーのデフォルト組織を保存
      try {
        await setDoc(doc(db, 'users', user.uid), {
          defaultOrgId: orgId,
          email: user.email
        }, { merge: true });
      } catch (err) {
        console.error('Error saving default org:', err);
      }
    }
  };

  // 新規組織を作成（システム管理者のみ）
  const createOrganization = async (name, tier = 'paid', ownerEmail = null) => {
    if (!isSystemAdmin) {
      throw new Error('システム管理者のみが組織を作成できます');
    }

    const orgRef = await addDoc(collection(db, 'organizations'), {
      name,
      tier,
      createdAt: serverTimestamp(),
      createdBy: user.uid
    });

    // オーナーを設定（指定があれば）
    if (ownerEmail) {
      await addDoc(collection(db, 'organizationMembers'), {
        orgId: orgRef.id,
        email: ownerEmail.toLowerCase(),
        uid: null, // ユーザーがログインした時に設定
        role: 'owner',
        joinedAt: serverTimestamp(),
        invitedBy: user.uid
      });
    }

    return orgRef.id;
  };

  // 組織にメンバーを追加
  const addMemberToOrg = async (orgId, email, role = 'member') => {
    const org = organizations.find(o => o.id === orgId);
    if (!org || (org.role !== 'owner' && org.role !== 'admin' && !isSystemAdmin)) {
      throw new Error('メンバーを追加する権限がありません');
    }

    // 重複チェック
    const existingQuery = query(
      collection(db, 'organizationMembers'),
      where('orgId', '==', orgId),
      where('email', '==', email.toLowerCase())
    );
    const existing = await getDocs(existingQuery);
    if (!existing.empty) {
      throw new Error('このメールアドレスは既に登録されています');
    }

    await addDoc(collection(db, 'organizationMembers'), {
      orgId,
      email: email.toLowerCase(),
      uid: null,
      role,
      joinedAt: serverTimestamp(),
      invitedBy: user.uid
    });
  };

  // メンバーシップをUIDに紐付け（ログイン時に呼ばれる）
  const linkMembershipToUid = async () => {
    if (!user) return;

    const q = query(
      collection(db, 'organizationMembers'),
      where('email', '==', user.email.toLowerCase()),
      where('uid', '==', null)
    );
    const snapshot = await getDocs(q);

    for (const docSnap of snapshot.docs) {
      await updateDoc(doc(db, 'organizationMembers', docSnap.id), {
        uid: user.uid
      });
    }
  };

  // ログイン時にメンバーシップをリンク
  useEffect(() => {
    if (user) {
      linkMembershipToUid();
    }
  }, [user]);

  return (
    <OrganizationContext.Provider value={{
      organizations,
      currentOrg,
      orgLoading,
      isSystemAdmin,
      switchOrganization,
      createOrganization,
      addMemberToOrg
    }}>
      {children}
    </OrganizationContext.Provider>
  );
}

function useOrganization() {
  return useContext(OrganizationContext);
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
// サマリー画像解析（Cloud Vision + Claude API）
// ============================================================
async function processSummaryImage(imageFile, onProgress) {
  try {
    if (onProgress) onProgress(10);

    // 画像をBase64に変換
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = reader.result.split(',')[1];
        resolve(base64String);
      };
      reader.onerror = reject;
      reader.readAsDataURL(imageFile);
    });

    if (onProgress) onProgress(30);

    // Cloud Functionsを呼び出し
    const processSummary = httpsCallable(functions, 'processSummaryImage');

    if (onProgress) onProgress(50);

    const result = await processSummary({ imageBase64: base64 });

    if (onProgress) onProgress(100);

    console.log('Summary Processing Result:', result.data);

    return result.data;
  } catch (error) {
    console.error('Summary Processing Error:', error);
    return {
      success: false,
      error: error.message || 'サマリー解析に失敗しました'
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
// 所属施設リスト（無料利用可能な施設）
const FREE_INSTITUTIONS = [
  { id: 'tmd-ped', name: '東京科学大学小児科', domain: 'tmd.ac.jp' },
  // 他の施設を追加する場合はここに追加
];

function LoginView() {
  const { signup, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [selectedInstitution, setSelectedInstitution] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
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
    if (isRegistering && !selectedInstitution) {
      setError('所属施設を選択してください');
      return;
    }
    if (isRegistering && !agreedToTerms) {
      setError('利用規約とプライバシーポリシーに同意してください');
      return;
    }

    setLoading(true);
    setError('');

    try {
      if (isRegistering) {
        const userCredential = await signup(email, password);
        const uid = userCredential.user.uid;

        // ユーザープロファイルを保存
        await setDoc(doc(db, 'users', uid), {
          email: email.toLowerCase(),
          institution: selectedInstitution,
          institutionName: FREE_INSTITUTIONS.find(i => i.id === selectedInstitution)?.name || 'その他',
          createdAt: serverTimestamp(),
          tier: selectedInstitution !== 'other' ? 'free' : 'external',
          agreedToTermsAt: serverTimestamp(),
          agreedToTermsVersion: '2026-02-06'
        });

        // 無料施設の場合、組織メンバーとして自動登録
        if (selectedInstitution && selectedInstitution !== 'other') {
          // 施設に対応する組織を検索
          const orgsQuery = query(
            collection(db, 'organizations'),
            where('institutionId', '==', selectedInstitution)
          );
          const orgsSnapshot = await getDocs(orgsQuery);

          if (!orgsSnapshot.empty) {
            const orgDoc = orgsSnapshot.docs[0];
            // 組織メンバーとして追加
            await addDoc(collection(db, 'organizationMembers'), {
              orgId: orgDoc.id,
              uid: uid,
              email: email.toLowerCase(),
              role: 'member',
              institution: selectedInstitution,
              joinedAt: serverTimestamp()
            });
          }
        }
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
            {isRegistering && (
              <div style={styles.inputGroup}>
                <label style={styles.inputLabel}>所属施設</label>
                <select
                  value={selectedInstitution}
                  onChange={(e) => setSelectedInstitution(e.target.value)}
                  style={styles.input}
                >
                  <option value="">-- 選択してください --</option>
                  {FREE_INSTITUTIONS.map(inst => (
                    <option key={inst.id} value={inst.id}>{inst.name}</option>
                  ))}
                  <option value="other">その他（外部）</option>
                </select>
                {selectedInstitution && selectedInstitution !== 'other' && (
                  <p style={{fontSize: '12px', color: '#059669', marginTop: '4px'}}>
                    ✓ 無料でご利用いただけます
                  </p>
                )}
                {selectedInstitution === 'other' && (
                  <p style={{fontSize: '12px', color: '#6b7280', marginTop: '4px'}}>
                    外部ユーザーとして登録されます
                  </p>
                )}
              </div>
            )}
            {isRegistering && (
              <div style={{marginTop: '16px'}}>
                <label style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#374151'
                }}>
                  <input
                    type="checkbox"
                    checked={agreedToTerms}
                    onChange={(e) => setAgreedToTerms(e.target.checked)}
                    style={{
                      marginTop: '3px',
                      width: '18px',
                      height: '18px',
                      cursor: 'pointer'
                    }}
                  />
                  <span>
                    <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={{color: '#2563eb', textDecoration: 'underline'}}>利用規約</a>
                    {' '}と{' '}
                    <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{color: '#2563eb', textDecoration: 'underline'}}>プライバシーポリシー</a>
                    {' '}に同意する
                  </span>
                </label>
              </div>
            )}
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
            データは暗号化されて保存されます<br/>
            患者の個人情報（氏名等）は保存されません
          </p>
          <div style={{marginTop: '12px', fontSize: '12px'}}>
            <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={{color: '#6b7280', textDecoration: 'none', marginRight: '12px'}}>
              利用規約
            </a>
            <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{color: '#6b7280', textDecoration: 'none'}}>
              プライバシーポリシー
            </a>
          </div>
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
  const { organizations, currentOrg, orgLoading, isSystemAdmin, switchOrganization, createOrganization, addMemberToOrg } = useOrganization();
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

  // システム管理パネル用state
  const [showSystemAdminPanel, setShowSystemAdminPanel] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgTier, setNewOrgTier] = useState('paid');
  const [newOrgOwnerEmail, setNewOrgOwnerEmail] = useState('');
  const [newOrgInstitutionId, setNewOrgInstitutionId] = useState('');
  const [allOrganizations, setAllOrganizations] = useState([]);
  const [isCreatingOrg, setIsCreatingOrg] = useState(false);
  const [bulkMemberInput, setBulkMemberInput] = useState('');
  const [selectedOrgForMembers, setSelectedOrgForMembers] = useState('');
  const [orgMembers, setOrgMembers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [adminPanelTab, setAdminPanelTab] = useState('organizations'); // 'organizations', 'users'

  // 管理者パネル用state
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [allowedEmails, setAllowedEmails] = useState([]);
  const [newAllowedEmail, setNewAllowedEmail] = useState('');
  const [bulkEmailInput, setBulkEmailInput] = useState(''); // 一括登録用
  const [isBulkAdding, setIsBulkAdding] = useState(false); // 一括登録中フラグ
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
  // サンプル選択モード: 'all'=全サンプル, 'first'=最初, 'last'=最後, 'closest'=指定日に最も近い
  const [sampleSelectionMode, setSampleSelectionMode] = useState('all');
  const [targetDay, setTargetDay] = useState(''); // 'closest'モードで使用
  const [sampleDetails, setSampleDetails] = useState(null); // 患者別サンプル数の詳細

  // 統計解析用state
  const [showStatisticalAnalysis, setShowStatisticalAnalysis] = useState(false);
  const [statChartType, setStatChartType] = useState('boxplot'); // 'boxplot', 'violin', 'bar', 'scatter'
  const [statSelectedItem, setStatSelectedItem] = useState('');
  const [statSelectedItems, setStatSelectedItems] = useState([]); // 複数選択用
  const [statResults, setStatResults] = useState(null);
  const [showDataPoints, setShowDataPoints] = useState('black'); // 'black', 'white', 'none'
  const statisticalChartRef = useRef(null);

  // ROC曲線解析用state
  const [showRocAnalysis, setShowRocAnalysis] = useState(false);
  const [rocSelectedItems, setRocSelectedItems] = useState([]);
  const [rocResults, setRocResults] = useState(null);
  const [isCalculatingRoc, setIsCalculatingRoc] = useState(false);
  const [rocRawData, setRocRawData] = useState(null); // Rスクリプト用生データ
  const rocChartRef = useRef(null);

  // 相関解析用state
  const [showCorrelationAnalysis, setShowCorrelationAnalysis] = useState(false);
  const [correlationSelectedItems, setCorrelationSelectedItems] = useState([]);
  const [correlationResults, setCorrelationResults] = useState(null);
  const [isCalculatingCorrelation, setIsCalculatingCorrelation] = useState(false);
  const [correlationType, setCorrelationType] = useState('spearman'); // 'spearman' or 'pearson'
  const [correlationRawData, setCorrelationRawData] = useState(null); // Rスクリプト用生データ
  const correlationChartRef = useRef(null);

  // ============================================================
  // Swimmer Plot（患者別タイムライン）
  // ============================================================
  const [showSwimmerPlot, setShowSwimmerPlot] = useState(false);
  const [swimmerData, setSwimmerData] = useState(null);
  const [swimmerSortBy, setSwimmerSortBy] = useState('duration'); // 'duration', 'onset', 'id'
  const [swimmerShowTreatments, setSwimmerShowTreatments] = useState(true);
  const [swimmerShowEvents, setSwimmerShowEvents] = useState(true);
  const [swimmerFilterHasData, setSwimmerFilterHasData] = useState(true); // データのある患者のみ表示
  const swimmerChartRef = useRef(null);

  // ============================================================
  // スパゲッティプロット（個別患者の検査値推移）
  // ============================================================
  const [showSpaghettiPlot, setShowSpaghettiPlot] = useState(false);
  const [spaghettiData, setSpaghettiData] = useState(null);
  const [spaghettiSelectedItem, setSpaghettiSelectedItem] = useState('');
  const [spaghettiColorByGroup, setSpaghettiColorByGroup] = useState(true);
  const [spaghettiShowPoints, setSpaghettiShowPoints] = useState(true);
  const [spaghettiSelectedPatients, setSpaghettiSelectedPatients] = useState([]);
  const spaghettiChartRef = useRef(null);

  // ============================================================
  // ヒートマップ（検査値の患者間比較）
  // ============================================================
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatmapData, setHeatmapData] = useState(null);
  const [heatmapSelectedItems, setHeatmapSelectedItems] = useState([]);
  const [heatmapSelectedPatients, setHeatmapSelectedPatients] = useState([]);
  const [heatmapSortBy, setHeatmapSortBy] = useState('group'); // 'group', 'id', 'value'
  const [heatmapTimepoint, setHeatmapTimepoint] = useState('first'); // 'first', 'last', 'peak'
  const [heatmapColorScale, setHeatmapColorScale] = useState('bluered'); // 'bluered', 'viridis', 'grayscale'
  const heatmapChartRef = useRef(null);

  // ============================================================
  // Kaplan-Meier用Tidy Dataエクスポート
  // ============================================================
  const [showKMExportModal, setShowKMExportModal] = useState(false);
  const [kmEventType, setKmEventType] = useState(''); // イベントタイプ（臨床イベントから選択）
  const [kmTimeUnit, setKmTimeUnit] = useState('days'); // 時間単位: days, weeks, months
  const [kmCensorDate, setKmCensorDate] = useState(''); // 打ち切り日（観察終了日）
  const [kmSelectedGroups, setKmSelectedGroups] = useState([]); // 比較する群
  const [kmAvailableEventTypes, setKmAvailableEventTypes] = useState([]); // 実際に登録されているイベントタイプ
  const [kmLoadingEventTypes, setKmLoadingEventTypes] = useState(false);

  // ============================================================
  // Kaplan-Meier曲線（アプリ内描画）
  // ============================================================
  const [showKMChart, setShowKMChart] = useState(false);
  const [kmChartData, setKmChartData] = useState(null);
  const [kmChartEventType, setKmChartEventType] = useState('');
  const [kmChartGroup1, setKmChartGroup1] = useState('');
  const [kmChartGroup2, setKmChartGroup2] = useState('');
  const [kmChartTimeUnit, setKmChartTimeUnit] = useState('days');
  const [kmChartCensorDate, setKmChartCensorDate] = useState('');
  const [kmChartLoading, setKmChartLoading] = useState(false);
  const kmChartRef = useRef(null);

  // ============================================================
  // 学術誌向けグラフスタイル設定
  // ============================================================
  const [chartColorPalette, setChartColorPalette] = useState('default'); // カラーパレット
  const [chartFontFamily, setChartFontFamily] = useState('arial'); // フォント
  const [chartExportDpi, setChartExportDpi] = useState(300); // 出力解像度

  // 学術誌向けカラーパレット定義（ggsci準拠）
  const journalColorPalettes = {
    default: {
      name: 'デフォルト',
      colors: ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'],
      description: '標準カラー'
    },
    nature: {
      name: 'Nature風',
      colors: ['#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F', '#8491B4', '#91D1C2', '#DC0000'],
      description: 'Nature Publishing Group'
    },
    nejm: {
      name: 'NEJM風',
      colors: ['#BC3C29', '#0072B5', '#E18727', '#20854E', '#7876B1', '#6F99AD', '#FFDC91', '#EE4C97'],
      description: 'New England Journal of Medicine'
    },
    lancet: {
      name: 'Lancet風',
      colors: ['#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F', '#FDAF91', '#AD002A', '#ADB6B6'],
      description: 'The Lancet'
    },
    jama: {
      name: 'JAMA風',
      colors: ['#374E55', '#DF8F44', '#00A1D5', '#B24745', '#79AF97', '#6A6599', '#80796B', '#0073C2'],
      description: 'Journal of the American Medical Association'
    },
    jco: {
      name: 'JCO風',
      colors: ['#0073C2', '#EFC000', '#868686', '#CD534C', '#7AA6DC', '#003C67', '#8F7700', '#3B3B3B'],
      description: 'Journal of Clinical Oncology'
    },
    colorblind: {
      name: '色覚対応',
      colors: ['#0077BB', '#33BBEE', '#009988', '#EE7733', '#CC3311', '#EE3377', '#BBBBBB', '#000000'],
      description: 'Colorblind-safe (Tol palette)'
    },
    grayscale: {
      name: 'グレースケール',
      colors: ['#000000', '#4d4d4d', '#7f7f7f', '#a6a6a6', '#c9c9c9', '#333333', '#666666', '#999999'],
      description: '白黒印刷用'
    }
  };

  // フォント設定
  const chartFontOptions = {
    arial: { name: 'Arial', css: 'Arial, Helvetica, sans-serif', description: 'Nature推奨' },
    helvetica: { name: 'Helvetica', css: 'Helvetica, Arial, sans-serif', description: 'Nature推奨' },
    times: { name: 'Times New Roman', css: '"Times New Roman", Times, serif', description: '伝統的' }
  };

  // 解像度設定
  const chartDpiOptions = [
    { value: 150, label: '150 DPI', description: 'プレビュー用' },
    { value: 300, label: '300 DPI', description: '投稿用（標準）' },
    { value: 600, label: '600 DPI', description: '高品質印刷用' }
  ];

  // 現在のパレットの色を取得するヘルパー関数
  const getPaletteColor = (index) => {
    const palette = journalColorPalettes[chartColorPalette] || journalColorPalettes.default;
    return palette.colors[index % palette.colors.length];
  };

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

  // メールアドレス一括登録
  const addBulkEmails = async () => {
    if (!bulkEmailInput.trim()) {
      alert('メールアドレスを入力してください');
      return;
    }

    setIsBulkAdding(true);
    try {
      // 改行、カンマ、セミコロン、スペースで分割
      const emails = bulkEmailInput
        .split(/[\n,;\s]+/)
        .map(e => e.toLowerCase().trim())
        .filter(e => e && e.includes('@')); // 空文字と@なしを除外

      if (emails.length === 0) {
        alert('有効なメールアドレスが見つかりませんでした');
        setIsBulkAdding(false);
        return;
      }

      // 重複を除外（入力内での重複 & 既存リストとの重複）
      const existingEmails = new Set(allowedEmails.map(e => e.email));
      const uniqueNewEmails = [...new Set(emails)].filter(e => !existingEmails.has(e));

      if (uniqueNewEmails.length === 0) {
        alert('全てのメールアドレスは既に登録されています');
        setIsBulkAdding(false);
        return;
      }

      // Firestoreに一括追加
      const newEntries = [];
      for (const email of uniqueNewEmails) {
        const docRef = await addDoc(collection(db, 'allowedEmails'), {
          email: email,
          addedAt: serverTimestamp(),
          addedBy: user.email
        });
        newEntries.push({ id: docRef.id, email: email });
      }

      setAllowedEmails([...allowedEmails, ...newEntries]);
      setBulkEmailInput('');

      const skipped = emails.length - uniqueNewEmails.length;
      let message = `${uniqueNewEmails.length}件のメールアドレスを登録しました`;
      if (skipped > 0) {
        message += `（${skipped}件は重複のためスキップ）`;
      }
      alert(message);
    } catch (err) {
      console.error('Error bulk adding emails:', err);
      alert('一括登録に失敗しました: ' + err.message);
    } finally {
      setIsBulkAdding(false);
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
              sheetName === '治療データ' || sheetName === '治療') {
            continue;
          }

          // 検査データシートを明示的に検出（優先処理）
          if (sheetName === '検査データ' || sheetName.includes('検査') || sheetName.includes('Lab')) {
            // 検査データとして処理（後続の処理に任せる）
          }
          // 臨床経過データシート（発作頻度推移、臨床イベントなど）を検出
          else if (sheetName.includes('発作') || sheetName.includes('頻度') || sheetName.includes('推移') ||
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

  // ===== ROC曲線解析関数 =====

  // ROC曲線の座標を計算
  const calculateROC = (positiveValues, negativeValues) => {
    if (!positiveValues || !negativeValues || positiveValues.length === 0 || negativeValues.length === 0) {
      return null;
    }

    // 全ての値を閾値候補としてソート
    const allValues = [...positiveValues, ...negativeValues].sort((a, b) => a - b);
    const thresholds = [-Infinity, ...allValues, Infinity];

    const rocPoints = [];
    const nPos = positiveValues.length;
    const nNeg = negativeValues.length;

    for (const threshold of thresholds) {
      // 閾値以上を陽性と予測
      const tp = positiveValues.filter(v => v >= threshold).length;
      const fp = negativeValues.filter(v => v >= threshold).length;
      const tn = nNeg - fp;
      const fn = nPos - tp;

      const tpr = nPos > 0 ? tp / nPos : 0; // 感度 (True Positive Rate)
      const fpr = nNeg > 0 ? fp / nNeg : 0; // 1-特異度 (False Positive Rate)
      const specificity = nNeg > 0 ? tn / nNeg : 0;

      rocPoints.push({
        threshold: threshold === -Infinity ? 'min' : threshold === Infinity ? 'max' : threshold,
        tpr,
        fpr,
        sensitivity: tpr,
        specificity,
        tp, fp, tn, fn
      });
    }

    // FPRでソート（ROC曲線描画用）
    rocPoints.sort((a, b) => a.fpr - b.fpr || b.tpr - a.tpr);

    return rocPoints;
  };

  // AUCを台形法で計算
  const calculateAUC = (rocPoints) => {
    if (!rocPoints || rocPoints.length < 2) return 0;

    let auc = 0;
    for (let i = 1; i < rocPoints.length; i++) {
      const width = rocPoints[i].fpr - rocPoints[i - 1].fpr;
      const height = (rocPoints[i].tpr + rocPoints[i - 1].tpr) / 2;
      auc += width * height;
    }
    return Math.max(0, Math.min(1, auc));
  };

  // AUCの95%信頼区間（Hanley-McNeil法の簡易版）
  const calculateAUCCI = (auc, nPos, nNeg) => {
    if (nPos < 2 || nNeg < 2) return { lower: 0, upper: 1 };

    // Hanley-McNeil法による標準誤差の近似
    const q1 = auc / (2 - auc);
    const q2 = (2 * auc * auc) / (1 + auc);
    const se = Math.sqrt((auc * (1 - auc) + (nPos - 1) * (q1 - auc * auc) + (nNeg - 1) * (q2 - auc * auc)) / (nPos * nNeg));

    const z = 1.96; // 95% CI
    const lower = Math.max(0, auc - z * se);
    const upper = Math.min(1, auc + z * se);

    return { lower, upper, se };
  };

  // 最適カットオフ値（Youden Index）
  const findOptimalCutoff = (rocPoints) => {
    if (!rocPoints || rocPoints.length === 0) return null;

    let maxYouden = -1;
    let optimalPoint = null;

    for (const point of rocPoints) {
      if (point.threshold === 'min' || point.threshold === 'max') continue;
      const youdenIndex = point.sensitivity + point.specificity - 1;
      if (youdenIndex > maxYouden) {
        maxYouden = youdenIndex;
        optimalPoint = { ...point, youdenIndex };
      }
    }

    return optimalPoint;
  };

  // ROC解析を実行
  const runRocAnalysis = async () => {
    if (!selectedGroup1 || !selectedGroup2 || rocSelectedItems.length === 0) {
      alert('2つの群とマーカーを選択してください');
      return;
    }

    setIsCalculatingRoc(true);

    const group1Patients = patients.filter(p => p.group === selectedGroup1);
    const group2Patients = patients.filter(p => p.group === selectedGroup2);

    const results = [];
    const rawData = {}; // Rスクリプト用生データ

    for (const itemName of rocSelectedItems) {
      let group1Values = [];
      let group2Values = [];

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

          if (!isInDayRange(dayFromOnset)) return;

          if (labData.data && Array.isArray(labData.data)) {
            const item = labData.data.find(d => d.item === itemName);
            if (item && !isNaN(parseFloat(item.value))) {
              group1Values.push(parseFloat(item.value));
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

          if (!isInDayRange(dayFromOnset)) return;

          if (labData.data && Array.isArray(labData.data)) {
            const item = labData.data.find(d => d.item === itemName);
            if (item && !isNaN(parseFloat(item.value))) {
              group2Values.push(parseFloat(item.value));
            }
          }
        });
      }

      // 1患者1サンプルモードの場合
      if (sampleSelectionMode !== 'all') {
        // 簡易的に最初/最後/closest を適用（group1Valuesは単純配列なのでここでは省略）
        // 実際にはpatient IDと紐づけて処理が必要だが、群間比較と同様のデータ構造が必要
      }

      if (group1Values.length >= 2 && group2Values.length >= 2) {
        // Group2を陽性（疾患群）、Group1を陰性（コントロール群）として計算
        // ユーザーの選択順に依存：group2が疾患群と仮定
        const rocPoints = calculateROC(group2Values, group1Values);

        if (rocPoints) {
          const auc = calculateAUC(rocPoints);
          const ci = calculateAUCCI(auc, group2Values.length, group1Values.length);
          const optimal = findOptimalCutoff(rocPoints);

          // AUCが0.5未満の場合、方向を逆転
          let finalAuc = auc;
          let finalRocPoints = rocPoints;
          let finalOptimal = optimal;
          let inverted = false;

          if (auc < 0.5) {
            // 逆方向で再計算
            const invertedRoc = calculateROC(group1Values, group2Values);
            finalAuc = calculateAUC(invertedRoc);
            finalRocPoints = invertedRoc;
            finalOptimal = findOptimalCutoff(invertedRoc);
            inverted = true;
          }

          const positiveGroup = inverted ? selectedGroup1 : selectedGroup2;
          const negativeGroup = inverted ? selectedGroup2 : selectedGroup1;

          results.push({
            item: itemName,
            auc: finalAuc,
            ci: calculateAUCCI(finalAuc, group2Values.length, group1Values.length),
            optimal: finalOptimal,
            rocPoints: finalRocPoints,
            nPositive: inverted ? group1Values.length : group2Values.length,
            nNegative: inverted ? group2Values.length : group1Values.length,
            positiveGroup,
            negativeGroup,
            inverted
          });

          // Rスクリプト用の生データを保存
          rawData[itemName] = {
            positiveValues: inverted ? [...group1Values] : [...group2Values],
            negativeValues: inverted ? [...group2Values] : [...group1Values],
            positiveGroup,
            negativeGroup
          };
        }
      }
    }

    setRocResults(results);
    setRocRawData(rawData);
    setIsCalculatingRoc(false);
  };

  // ROC曲線のカラーパレット（学術誌スタイル設定に連動）
  const getRocColors = () => {
    const palette = journalColorPalettes[chartColorPalette] || journalColorPalettes.default;
    return palette.colors;
  };
  const rocColors = getRocColors();

  // ===== ROC曲線解析関数 ここまで =====

  // ===== 相関解析関数 =====

  // Pearson相関係数
  const pearsonCorrelation = (x, y) => {
    if (!x || !y || x.length !== y.length || x.length < 3) {
      return { r: null, p: null };
    }
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
    const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
    const sumY2 = y.reduce((acc, yi) => acc + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    if (denominator === 0) return { r: 0, p: 1 };

    const r = numerator / denominator;

    // t検定でp値を計算
    const t = r * Math.sqrt((n - 2) / (1 - r * r));
    const df = n - 2;
    // p値近似（両側検定）
    const p = 2 * (1 - tDistCDF(Math.abs(t), df));

    return { r, p: Math.max(0.0001, p) };
  };

  // t分布CDF（簡易版）
  const tDistCDF = (t, df) => {
    const x = df / (df + t * t);
    return 1 - 0.5 * betaIncomplete(df / 2, 0.5, x);
  };

  // Spearman順位相関係数
  const spearmanCorrelation = (x, y) => {
    if (!x || !y || x.length !== y.length || x.length < 3) {
      return { r: null, p: null };
    }
    const n = x.length;

    // 順位に変換
    const rankArray = (arr) => {
      const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
      const ranks = new Array(n);
      let i = 0;
      while (i < n) {
        let j = i;
        while (j < n - 1 && sorted[j].v === sorted[j + 1].v) j++;
        const avgRank = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) {
          ranks[sorted[k].i] = avgRank;
        }
        i = j + 1;
      }
      return ranks;
    };

    const rankX = rankArray(x);
    const rankY = rankArray(y);

    // Pearson相関を順位に適用
    return pearsonCorrelation(rankX, rankY);
  };

  // 相関解析を実行
  const runCorrelationAnalysis = async () => {
    if (correlationSelectedItems.length < 2) {
      alert('2つ以上のマーカーを選択してください');
      return;
    }

    setIsCalculatingCorrelation(true);

    // 選択された患者からデータを収集
    const targetPatients = selectedPatientIds.length > 0
      ? patients.filter(p => selectedPatientIds.includes(p.id))
      : patients;

    // マーカーごとのデータを収集（患者×日付ごとにペアを作成）
    const dataByPatientDate = {}; // { patientId_date: { marker1: value, marker2: value, ... } }

    for (const patient of targetPatients) {
      const labQuery = query(
        collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
        orderBy('date', 'asc')
      );
      const labSnapshot = await getDocs(labQuery);

      labSnapshot.docs.forEach(labDoc => {
        const labData = labDoc.data();
        const labDate = labData.date;
        const dayFromOnset = calcDayFromOnset(patient, labDate);

        if (!isInDayRange(dayFromOnset)) return;

        const key = `${patient.id}_${labDate}`;
        if (!dataByPatientDate[key]) {
          dataByPatientDate[key] = {};
        }

        if (labData.data && Array.isArray(labData.data)) {
          correlationSelectedItems.forEach(itemName => {
            const item = labData.data.find(d => d.item === itemName);
            if (item && !isNaN(parseFloat(item.value))) {
              dataByPatientDate[key][itemName] = parseFloat(item.value);
            }
          });
        }
      });
    }

    // 相関行列を計算
    const items = correlationSelectedItems;
    const matrix = [];
    const pMatrix = [];

    for (let i = 0; i < items.length; i++) {
      matrix[i] = [];
      pMatrix[i] = [];
      for (let j = 0; j < items.length; j++) {
        if (i === j) {
          matrix[i][j] = 1;
          pMatrix[i][j] = 0;
        } else {
          // 両方のマーカーが存在するデータポイントのみ使用
          const pairs = Object.values(dataByPatientDate)
            .filter(d => d[items[i]] !== undefined && d[items[j]] !== undefined)
            .map(d => [d[items[i]], d[items[j]]]);

          if (pairs.length >= 3) {
            const x = pairs.map(p => p[0]);
            const y = pairs.map(p => p[1]);
            const result = correlationType === 'spearman'
              ? spearmanCorrelation(x, y)
              : pearsonCorrelation(x, y);
            matrix[i][j] = result.r ?? 0;
            pMatrix[i][j] = result.p ?? 1;
          } else {
            matrix[i][j] = null;
            pMatrix[i][j] = null;
          }
        }
      }
    }

    // ペア数をカウント
    const pairCounts = [];
    for (let i = 0; i < items.length; i++) {
      pairCounts[i] = [];
      for (let j = 0; j < items.length; j++) {
        const pairs = Object.values(dataByPatientDate)
          .filter(d => d[items[i]] !== undefined && d[items[j]] !== undefined);
        pairCounts[i][j] = pairs.length;
      }
    }

    setCorrelationResults({
      items,
      matrix,
      pMatrix,
      pairCounts,
      type: correlationType
    });

    // Rスクリプト用の生データを保存
    setCorrelationRawData(dataByPatientDate);
    setIsCalculatingCorrelation(false);
  };

  // 相関係数の色を取得
  const getCorrelationColor = (r) => {
    if (r === null) return '#f3f4f6'; // グレー
    // 青(-1) → 白(0) → 赤(+1)
    const absR = Math.abs(r);
    if (r > 0) {
      // 赤方向
      const red = 255;
      const green = Math.round(255 * (1 - absR));
      const blue = Math.round(255 * (1 - absR));
      return `rgb(${red}, ${green}, ${blue})`;
    } else if (r < 0) {
      // 青方向
      const red = Math.round(255 * (1 - absR));
      const green = Math.round(255 * (1 - absR));
      const blue = 255;
      return `rgb(${red}, ${green}, ${blue})`;
    }
    return '#ffffff';
  };

  // 有意性マーカー
  const getCorrelationSignificance = (p) => {
    if (p === null) return '';
    if (p < 0.001) return '***';
    if (p < 0.01) return '**';
    if (p < 0.05) return '*';
    return '';
  };

  // ===== 相関解析関数 ここまで =====

  // ===== Swimmer Plot関数 =====

  // Swimmer Plot用データを生成
  const generateSwimmerData = async () => {
    if (!patients || patients.length === 0) return null;

    const swimmerPatients = [];

    for (const patient of patients) {
      // 発症日を基準日として計算
      const onsetDate = patient.onsetDate ? new Date(patient.onsetDate) : null;

      // 治療データを取得
      let treatments = [];
      let events = [];
      let labResults = [];

      try {
        // 治療薬データ
        const treatmentQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'treatments'),
          orderBy('startDate', 'asc')
        );
        const treatmentSnapshot = await getDocs(treatmentQuery);
        treatments = treatmentSnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));

        // 臨床イベントデータ
        const eventQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
          orderBy('startDate', 'asc')
        );
        const eventSnapshot = await getDocs(eventQuery);
        events = eventSnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));

        // 検査データ（最終フォローアップ日を取得するため）
        const labQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
          orderBy('date', 'desc'),
          limit(1)
        );
        const labSnapshot = await getDocs(labQuery);
        labResults = labSnapshot.docs.map(doc => doc.data());
      } catch (err) {
        console.error('Error fetching swimmer data:', err);
      }

      // 観察期間の計算
      let startDay = 0;
      let endDay = 0;

      if (onsetDate) {
        // 最終フォローアップ日を計算
        const allDates = [
          ...treatments.flatMap(t => [t.startDate, t.endDate].filter(Boolean)),
          ...events.flatMap(e => [e.startDate, e.endDate].filter(Boolean)),
          ...labResults.map(l => l.date).filter(Boolean)
        ].map(d => new Date(d));

        if (allDates.length > 0) {
          const lastDate = new Date(Math.max(...allDates));
          endDay = Math.floor((lastDate - onsetDate) / (1000 * 60 * 60 * 24));
        }
      }

      // 治療をDay形式に変換
      const treatmentBars = treatments.map(t => {
        const startDate = t.startDate ? new Date(t.startDate) : null;
        const endDate = t.endDate ? new Date(t.endDate) : null;

        let dayStart = 0;
        let dayEnd = endDay;

        if (onsetDate && startDate) {
          dayStart = Math.floor((startDate - onsetDate) / (1000 * 60 * 60 * 24));
        }
        if (onsetDate && endDate) {
          dayEnd = Math.floor((endDate - onsetDate) / (1000 * 60 * 60 * 24));
        }

        return {
          name: t.name,
          category: t.category,
          dayStart,
          dayEnd,
          ongoing: !t.endDate
        };
      });

      // イベントをDay形式に変換
      const eventMarkers = events.map(e => {
        const eventDate = e.startDate ? new Date(e.startDate) : null;
        let day = 0;

        if (onsetDate && eventDate) {
          day = Math.floor((eventDate - onsetDate) / (1000 * 60 * 60 * 24));
        }

        return {
          type: e.eventType || e.type || 'その他',
          day,
          isOngoing: e.isOngoing || !e.endDate
        };
      });

      swimmerPatients.push({
        id: patient.id,
        displayId: patient.displayId,
        group: patient.group || '',
        diagnosis: patient.diagnosis || '',
        onsetDate: patient.onsetDate,
        startDay,
        endDay: Math.max(endDay, 30), // 最低30日
        treatments: treatmentBars,
        events: eventMarkers
      });
    }

    // ソート
    swimmerPatients.sort((a, b) => {
      if (swimmerSortBy === 'duration') {
        return b.endDay - a.endDay;
      } else if (swimmerSortBy === 'onset') {
        return new Date(a.onsetDate || '9999') - new Date(b.onsetDate || '9999');
      } else {
        return a.displayId.localeCompare(b.displayId);
      }
    });

    return swimmerPatients;
  };

  // Swimmer Plotを実行
  const runSwimmerPlot = async () => {
    const data = await generateSwimmerData();
    setSwimmerData(data);
  };

  // ============================================================
  // スパゲッティプロット データ生成
  // ============================================================
  const generateSpaghettiData = async () => {
    if (!patients || patients.length === 0) return null;


    const allLabItems = new Set();
    const patientLabData = [];

    for (const patient of patients) {
      const onsetDate = patient.onsetDate ? new Date(patient.onsetDate) : null;

      try {
        const labQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
          orderBy('date', 'asc')
        );
        const labSnapshot = await getDocs(labQuery);
        const labResults = labSnapshot.docs.map(doc => doc.data());


        // 患者ごとのデータポイントを収集
        const dataPoints = [];

        labResults.forEach(lab => {
          const labDate = lab.date ? new Date(lab.date) : null;
          let day = null;
          if (onsetDate && labDate) {
            day = Math.floor((labDate - onsetDate) / (1000 * 60 * 60 * 24));
          }

          // data配列形式の場合
          if (lab.data && Array.isArray(lab.data)) {
            lab.data.forEach(item => {
              // 日付形式の項目名を除外
              const isDateItem = /^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(item.item);
              if (isDateItem) return;

              if (item.item && item.value !== undefined && item.value !== null && item.value !== '') {
                allLabItems.add(item.item);
                const value = parseFloat(item.value);
                if (!isNaN(value)) {
                  dataPoints.push({
                    item: item.item,
                    value,
                    day,
                    date: lab.date,
                    unit: item.unit || ''
                  });
                }
              }
            });
          }

          // itemsオブジェクト形式の場合
          if (lab.items && typeof lab.items === 'object') {
            Object.entries(lab.items).forEach(([itemName, itemData]) => {
              // 日付形式のキーを除外（YYYY-MM-DD, YYYY/MM/DD など）
              const isDateKey = /^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(itemName);
              if (isDateKey) return;

              if (itemName && itemData?.value !== undefined && itemData?.value !== null && itemData?.value !== '') {
                allLabItems.add(itemName);
                const value = parseFloat(itemData.value);
                if (!isNaN(value)) {
                  dataPoints.push({
                    item: itemName,
                    value,
                    day,
                    date: lab.date,
                    unit: itemData.unit || ''
                  });
                }
              }
            });
          }

          // 従来のフラット形式の場合（item, value直接）
          if (lab.item && lab.value !== undefined) {
            allLabItems.add(lab.item);
            const value = parseFloat(lab.value);
            if (!isNaN(value)) {
              dataPoints.push({
                item: lab.item,
                value,
                day,
                date: lab.date,
                unit: lab.unit || ''
              });
            }
          }
        });


        patientLabData.push({
          id: patient.id,
          displayId: patient.displayId,
          group: patient.group || 'その他',
          diagnosis: patient.diagnosis,
          dataPoints
        });
      } catch (err) {
        console.error('Error fetching lab data for spaghetti plot:', err);
      }
    }

    // 全患者を選択状態に
    setSpaghettiSelectedPatients(patients.map(p => p.id));

    // 検査項目リストを作成
    const itemsArray = Array.from(allLabItems).sort();

    // データをセット
    const newData = {
      patients: patientLabData,
      labItems: itemsArray,
      groups: [...new Set(patients.map(p => p.group || 'その他'))]
    };

    setSpaghettiData(newData);

    // 最初の検査項目を選択（データセット後に行う）
    if (itemsArray.length > 0) {
      setSpaghettiSelectedItem(itemsArray[0]);
    }

    return newData;
  };

  // スパゲッティプロット用カラーパレット（群別）
  const spaghettiGroupColors = {
    'default': ['#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'],
  };

  // 群に基づく色を取得
  const getGroupColor = (group, groups) => {
    const colors = spaghettiGroupColors.default;
    const index = groups.indexOf(group);
    return colors[index % colors.length];
  };

  // ヒートマップデータ生成関数
  const generateHeatmapData = async () => {
    if (!patients || patients.length === 0) return null;

    const allLabItems = new Map(); // item -> { min, max, unit }
    const patientData = [];

    for (const patient of patients) {
      const onsetDate = patient.onsetDate ? new Date(patient.onsetDate) : null;

      try {
        const labQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
          orderBy('date', 'asc')
        );
        const labSnapshot = await getDocs(labQuery);
        const labResults = labSnapshot.docs.map(doc => doc.data());

        // 患者ごとの各検査項目のデータを収集
        const itemValues = new Map(); // item -> [{value, day, date}]

        labResults.forEach(lab => {
          const labDate = lab.date ? new Date(lab.date) : null;
          let day = null;
          if (onsetDate && labDate) {
            day = Math.floor((labDate - onsetDate) / (1000 * 60 * 60 * 24));
          }

          // data配列形式の場合
          if (lab.data && Array.isArray(lab.data)) {
            lab.data.forEach(item => {
              const isDateItem = /^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(item.item);
              if (isDateItem) return;

              if (item.item && item.value !== undefined && item.value !== null && item.value !== '') {
                const value = parseFloat(item.value);
                if (!isNaN(value)) {
                  if (!itemValues.has(item.item)) itemValues.set(item.item, []);
                  itemValues.get(item.item).push({ value, day, date: lab.date });

                  // min/max追跡
                  if (!allLabItems.has(item.item)) {
                    allLabItems.set(item.item, { min: value, max: value, unit: item.unit || '' });
                  } else {
                    const info = allLabItems.get(item.item);
                    info.min = Math.min(info.min, value);
                    info.max = Math.max(info.max, value);
                  }
                }
              }
            });
          }

          // itemsオブジェクト形式の場合
          if (lab.items && typeof lab.items === 'object') {
            Object.entries(lab.items).forEach(([itemName, itemData]) => {
              const isDateKey = /^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(itemName);
              if (isDateKey) return;

              if (itemName && itemData?.value !== undefined && itemData?.value !== null && itemData?.value !== '') {
                const value = parseFloat(itemData.value);
                if (!isNaN(value)) {
                  if (!itemValues.has(itemName)) itemValues.set(itemName, []);
                  itemValues.get(itemName).push({ value, day, date: lab.date });

                  if (!allLabItems.has(itemName)) {
                    allLabItems.set(itemName, { min: value, max: value, unit: itemData.unit || '' });
                  } else {
                    const info = allLabItems.get(itemName);
                    info.min = Math.min(info.min, value);
                    info.max = Math.max(info.max, value);
                  }
                }
              }
            });
          }

          // 従来のフラット形式の場合
          if (lab.item && lab.value !== undefined) {
            const value = parseFloat(lab.value);
            if (!isNaN(value)) {
              if (!itemValues.has(lab.item)) itemValues.set(lab.item, []);
              itemValues.get(lab.item).push({ value, day, date: lab.date });

              if (!allLabItems.has(lab.item)) {
                allLabItems.set(lab.item, { min: value, max: value, unit: lab.unit || '' });
              } else {
                const info = allLabItems.get(lab.item);
                info.min = Math.min(info.min, value);
                info.max = Math.max(info.max, value);
              }
            }
          }
        });

        patientData.push({
          id: patient.id,
          displayId: patient.displayId,
          group: patient.group || 'その他',
          diagnosis: patient.diagnosis,
          itemValues: Object.fromEntries(itemValues)
        });
      } catch (err) {
        console.error('Error fetching lab data for heatmap:', err);
      }
    }

    // 全検査項目リスト（データ数でソート）
    const itemsArray = Array.from(allLabItems.keys()).sort((a, b) => {
      const countA = patientData.filter(p => p.itemValues[a]?.length > 0).length;
      const countB = patientData.filter(p => p.itemValues[b]?.length > 0).length;
      return countB - countA; // データ数の多い順
    });

    // データをセット
    const newData = {
      patients: patientData,
      labItems: itemsArray,
      itemInfo: Object.fromEntries(allLabItems),
      groups: [...new Set(patients.map(p => p.group || 'その他'))]
    };

    setHeatmapData(newData);

    // 上位10項目を自動選択
    setHeatmapSelectedItems(itemsArray.slice(0, Math.min(10, itemsArray.length)));

    // 全患者を選択状態に
    setHeatmapSelectedPatients(patients.map(p => p.id));

    return newData;
  };

  // ヒートマップ用のカラースケール取得
  const getHeatmapColor = (normalizedValue, colorScale) => {
    if (normalizedValue === null || normalizedValue === undefined) {
      return '#f3f4f6'; // データなし
    }

    const v = Math.max(0, Math.min(1, normalizedValue));

    switch (colorScale) {
      case 'bluered':
        // 青（低）→ 白（中）→ 赤（高）
        if (v < 0.5) {
          const t = v * 2;
          const r = Math.round(59 + (255 - 59) * t);
          const g = Math.round(130 + (255 - 130) * t);
          const b = Math.round(246 + (255 - 246) * t);
          return `rgb(${r}, ${g}, ${b})`;
        } else {
          const t = (v - 0.5) * 2;
          const r = 255;
          const g = Math.round(255 - (255 - 68) * t);
          const b = Math.round(255 - (255 - 68) * t);
          return `rgb(${r}, ${g}, ${b})`;
        }
      case 'viridis':
        // Viridis-likeカラースケール
        const viridisColors = [
          [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
          [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89],
          [180, 222, 44], [253, 231, 37]
        ];
        const idx = Math.min(Math.floor(v * (viridisColors.length - 1)), viridisColors.length - 2);
        const t = (v * (viridisColors.length - 1)) - idx;
        const c1 = viridisColors[idx];
        const c2 = viridisColors[idx + 1];
        const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
        const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
        const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
        return `rgb(${r}, ${g}, ${b})`;
      case 'grayscale':
        const gray = Math.round(240 - v * 200);
        return `rgb(${gray}, ${gray}, ${gray})`;
      default:
        return '#3b82f6';
    }
  };

  // 治療カテゴリのカラーマップ
  const treatmentColorMap = {
    '抗てんかん薬': '#3b82f6',
    'ステロイド': '#ef4444',
    '免疫グロブリン': '#22c55e',
    '血漿交換': '#f59e0b',
    '免疫抑制剤': '#8b5cf6',
    '抗ウイルス薬': '#ec4899',
    '抗菌薬': '#06b6d4',
    '抗浮腫薬': '#84cc16',
    'その他': '#6b7280'
  };

  // イベントタイプのシンボルマップ
  const eventSymbolMap = {
    '意識障害': { symbol: '●', color: '#dc2626' },
    'てんかん発作': { symbol: '◆', color: '#ea580c' },
    '不随意運動': { symbol: '▲', color: '#ca8a04' },
    '麻痺': { symbol: '■', color: '#16a34a' },
    '発熱': { symbol: '★', color: '#dc2626' },
    '人工呼吸器管理': { symbol: '✚', color: '#7c3aed' },
    'ICU入室': { symbol: '◎', color: '#be185d' },
    'default': { symbol: '●', color: '#6b7280' }
  };

  // ===== Swimmer Plot関数 ここまで =====

  // ===== Rスクリプト・生データエクスポート関数 =====

  // 群間比較用の生データCSVを生成
  const exportGroupComparisonRawData = () => {
    if (!comparisonResults || comparisonResults.length === 0) return;

    // 各検査項目ごとにデータを整理
    let csvContent = 'patient_id,group,item,value,date,day_from_onset\n';

    comparisonResults.forEach(r => {
      // Group 1のデータ
      r.group1.data.forEach(d => {
        csvContent += `${d.id},${selectedGroup1},${r.item},${d.value},${d.date},${d.day ?? ''}\n`;
      });
      // Group 2のデータ
      r.group2.data.forEach(d => {
        csvContent += `${d.id},${selectedGroup2},${r.item},${d.value},${d.date},${d.day ?? ''}\n`;
      });
    });

    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `group_comparison_raw_data_${selectedGroup1}_vs_${selectedGroup2}_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 群間比較用のRスクリプトを生成
  const exportGroupComparisonRScript = () => {
    if (!comparisonResults || comparisonResults.length === 0) return;

    const items = comparisonResults.map(r => r.item);

    const rScript = `# ============================================
# 群間統計比較 - Rスクリプト
# 生成日時: ${new Date().toLocaleString('ja-JP')}
# 群1: ${selectedGroup1}
# 群2: ${selectedGroup2}
# ============================================

# 必要なパッケージをインストール（未インストールの場合）
if (!require("ggplot2")) install.packages("ggplot2")
if (!require("dplyr")) install.packages("dplyr")
if (!require("tidyr")) install.packages("tidyr")

library(ggplot2)
library(dplyr)
library(tidyr)

# データ読み込み
# ※ CSVファイルのパスを適宜変更してください
data <- read.csv("group_comparison_raw_data_${selectedGroup1}_vs_${selectedGroup2}_${new Date().toISOString().split('T')[0]}.csv",
                 fileEncoding = "UTF-8-BOM")

# データ確認
head(data)
str(data)

# 検査項目リスト
items <- c(${items.map(i => `"${i}"`).join(', ')})

# ============================================
# 統計解析
# ============================================

results <- data.frame()

for (item_name in items) {
  item_data <- data %>% filter(item == item_name)

  group1_vals <- item_data %>% filter(group == "${selectedGroup1}") %>% pull(value)
  group2_vals <- item_data %>% filter(group == "${selectedGroup2}") %>% pull(value)

  if (length(group1_vals) >= 2 && length(group2_vals) >= 2) {
    # 正規性検定（Shapiro-Wilk）
    shapiro_g1 <- if(length(group1_vals) >= 3 && length(group1_vals) <= 5000) shapiro.test(group1_vals)$p.value else NA
    shapiro_g2 <- if(length(group2_vals) >= 3 && length(group2_vals) <= 5000) shapiro.test(group2_vals)$p.value else NA

    # Welchのt検定
    t_result <- t.test(group1_vals, group2_vals, var.equal = FALSE)

    # Mann-Whitney U検定（Wilcoxon順位和検定）
    wilcox_result <- wilcox.test(group1_vals, group2_vals, exact = FALSE)

    results <- rbind(results, data.frame(
      item = item_name,
      n_group1 = length(group1_vals),
      mean_group1 = mean(group1_vals),
      sd_group1 = sd(group1_vals),
      median_group1 = median(group1_vals),
      n_group2 = length(group2_vals),
      mean_group2 = mean(group2_vals),
      sd_group2 = sd(group2_vals),
      median_group2 = median(group2_vals),
      shapiro_p_group1 = shapiro_g1,
      shapiro_p_group2 = shapiro_g2,
      t_statistic = t_result$statistic,
      t_p_value = t_result$p.value,
      wilcox_p_value = wilcox_result$p.value
    ))
  }
}

# 結果表示
print(results)

# 結果保存
write.csv(results, "group_comparison_results_R.csv", row.names = FALSE)

# ============================================
# Box Plot作成
# ============================================

for (item_name in items) {
  item_data <- data %>% filter(item == item_name)

  if (nrow(item_data) > 0) {
    p <- ggplot(item_data, aes(x = group, y = value, fill = group)) +
      geom_boxplot(alpha = 0.7, outlier.shape = NA) +
      geom_jitter(width = 0.2, alpha = 0.5, size = 1.5) +
      labs(title = item_name,
           x = "Group",
           y = "Value") +
      theme_classic() +
      theme(legend.position = "none",
            plot.title = element_text(hjust = 0.5, face = "bold"))

    # p値を追加
    result_row <- results %>% filter(item == item_name)
    if (nrow(result_row) > 0) {
      p_val <- result_row$wilcox_p_value[1]
      p_text <- if(p_val < 0.001) "p < 0.001" else paste0("p = ", round(p_val, 3))
      p <- p + annotate("text", x = 1.5, y = max(item_data$value) * 1.1,
                        label = p_text, size = 4)
    }

    print(p)
    ggsave(paste0("boxplot_", gsub("/", "_", item_name), ".png"), p, width = 6, height = 5, dpi = 300)
  }
}

# ============================================
# 複数項目を1つのグラフに（オプション）
# ============================================

if (length(items) <= 6) {
  p_all <- ggplot(data, aes(x = group, y = value, fill = group)) +
    geom_boxplot(alpha = 0.7, outlier.shape = NA) +
    geom_jitter(width = 0.2, alpha = 0.5, size = 1) +
    facet_wrap(~ item, scales = "free_y") +
    labs(x = "Group", y = "Value") +
    theme_classic() +
    theme(legend.position = "bottom",
          strip.text = element_text(face = "bold"))

  print(p_all)
  ggsave("boxplot_all_items.png", p_all, width = 10, height = 8, dpi = 300)
}

cat("\\n解析完了！\\n")
`;

    const blob = new Blob([rScript], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `group_comparison_analysis_${selectedGroup1}_vs_${selectedGroup2}.R`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ROC解析用の生データCSVを生成
  const exportRocRawData = () => {
    if (!rocResults || rocResults.length === 0) return;

    let csvContent = 'marker,group,group_label,value\n';

    rocResults.forEach(r => {
      // rocPointsから元データを復元するのは難しいので、
      // 解析時にrawDataを保存しておく必要がある
      // ここではrocRawDataステートを使用
      if (rocRawData && rocRawData[r.item]) {
        const { positiveValues, negativeValues, positiveGroup, negativeGroup } = rocRawData[r.item];
        positiveValues.forEach(v => {
          csvContent += `${r.item},positive,${positiveGroup},${v}\n`;
        });
        negativeValues.forEach(v => {
          csvContent += `${r.item},negative,${negativeGroup},${v}\n`;
        });
      }
    });

    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roc_raw_data_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ROC解析用のRスクリプトを生成
  const exportRocRScript = () => {
    if (!rocResults || rocResults.length === 0) return;

    const markers = rocResults.map(r => r.item);

    const rScript = `# ============================================
# ROC曲線解析 - Rスクリプト
# 生成日時: ${new Date().toLocaleString('ja-JP')}
# マーカー: ${markers.join(', ')}
# ============================================

# 必要なパッケージをインストール（未インストールの場合）
if (!require("pROC")) install.packages("pROC")
if (!require("ggplot2")) install.packages("ggplot2")
if (!require("dplyr")) install.packages("dplyr")

library(pROC)
library(ggplot2)
library(dplyr)

# データ読み込み
# ※ CSVファイルのパスを適宜変更してください
data <- read.csv("roc_raw_data_${new Date().toISOString().split('T')[0]}.csv",
                 fileEncoding = "UTF-8-BOM")

# データ確認
head(data)
table(data$marker, data$group)

# マーカーリスト
markers <- c(${markers.map(m => `"${m}"`).join(', ')})

# ============================================
# ROC解析
# ============================================

results <- data.frame()
roc_objects <- list()

for (marker_name in markers) {
  marker_data <- data %>% filter(marker == marker_name)

  if (nrow(marker_data) >= 4) {
    # group列を0/1に変換（positive = 1, negative = 0）
    marker_data$outcome <- ifelse(marker_data$group == "positive", 1, 0)

    # ROC曲線を計算
    roc_obj <- roc(marker_data$outcome, marker_data$value, quiet = TRUE)
    roc_objects[[marker_name]] <- roc_obj

    # AUCと95%信頼区間
    auc_val <- auc(roc_obj)
    ci_val <- ci.auc(roc_obj, method = "delong")

    # 最適カットオフ（Youden Index）
    coords_best <- coords(roc_obj, "best", ret = c("threshold", "sensitivity", "specificity"))

    results <- rbind(results, data.frame(
      marker = marker_name,
      auc = as.numeric(auc_val),
      ci_lower = ci_val[1],
      ci_upper = ci_val[3],
      cutoff = coords_best$threshold,
      sensitivity = coords_best$sensitivity,
      specificity = coords_best$specificity,
      youden_index = coords_best$sensitivity + coords_best$specificity - 1,
      n_positive = sum(marker_data$outcome == 1),
      n_negative = sum(marker_data$outcome == 0)
    ))
  }
}

# 結果表示
print(results)

# 結果保存
write.csv(results, "roc_analysis_results_R.csv", row.names = FALSE)

# ============================================
# ROC曲線プロット
# ============================================

# 個別ROC曲線
for (marker_name in names(roc_objects)) {
  roc_obj <- roc_objects[[marker_name]]
  result_row <- results %>% filter(marker == marker_name)

  png(paste0("roc_curve_", gsub("/", "_", marker_name), ".png"), width = 600, height = 600, res = 100)
  plot(roc_obj,
       main = paste0("ROC Curve: ", marker_name),
       col = "blue", lwd = 2,
       print.auc = TRUE, print.auc.y = 0.4,
       print.thres = TRUE, print.thres.col = "red")
  abline(a = 0, b = 1, lty = 2, col = "gray")
  dev.off()
}

# 複数マーカーを1つのグラフに
if (length(roc_objects) > 1) {
  colors <- rainbow(length(roc_objects))

  png("roc_curves_combined.png", width = 800, height = 700, res = 100)
  plot(roc_objects[[1]], col = colors[1], lwd = 2, main = "ROC Curves Comparison")

  for (i in 2:length(roc_objects)) {
    plot(roc_objects[[i]], col = colors[i], lwd = 2, add = TRUE)
  }

  legend("bottomright",
         legend = paste0(names(roc_objects), " (AUC=", round(results$auc, 3), ")"),
         col = colors, lwd = 2)
  abline(a = 0, b = 1, lty = 2, col = "gray")
  dev.off()
}

# ggplot2版（より美しいグラフ）
roc_plot_data <- data.frame()
for (marker_name in names(roc_objects)) {
  roc_obj <- roc_objects[[marker_name]]
  auc_val <- round(auc(roc_obj), 3)
  roc_plot_data <- rbind(roc_plot_data, data.frame(
    marker = paste0(marker_name, " (AUC=", auc_val, ")"),
    specificity = roc_obj$specificities,
    sensitivity = roc_obj$sensitivities
  ))
}

p_roc <- ggplot(roc_plot_data, aes(x = 1 - specificity, y = sensitivity, color = marker)) +
  geom_line(linewidth = 1) +
  geom_abline(intercept = 0, slope = 1, linetype = "dashed", color = "gray50") +
  labs(title = "ROC Curves",
       x = "1 - Specificity (False Positive Rate)",
       y = "Sensitivity (True Positive Rate)",
       color = "Marker") +
  theme_classic() +
  theme(legend.position = "bottom",
        plot.title = element_text(hjust = 0.5, face = "bold")) +
  coord_equal()

print(p_roc)
ggsave("roc_curves_ggplot.png", p_roc, width = 8, height = 7, dpi = 300)

# ============================================
# AUC比較（DeLong検定）
# ============================================

if (length(roc_objects) >= 2) {
  cat("\\n=== AUC比較（DeLong検定）===\\n")
  marker_names <- names(roc_objects)
  for (i in 1:(length(marker_names)-1)) {
    for (j in (i+1):length(marker_names)) {
      comparison <- roc.test(roc_objects[[marker_names[i]]],
                             roc_objects[[marker_names[j]]],
                             method = "delong")
      cat(sprintf("%s vs %s: p = %.4f\\n",
                  marker_names[i], marker_names[j], comparison$p.value))
    }
  }
}

cat("\\n解析完了！\\n")
`;

    const blob = new Blob([rScript], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roc_analysis_${markers.length}markers.R`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 相関解析用の生データCSVを生成
  const exportCorrelationRawData = () => {
    if (!correlationResults || !correlationRawData) return;

    const items = correlationResults.items;

    // Wide format: 行 = patient_date, 列 = markers
    let csvContent = 'sample_id,' + items.join(',') + '\n';

    Object.entries(correlationRawData).forEach(([key, values]) => {
      const row = [key];
      items.forEach(item => {
        row.push(values[item] !== undefined ? values[item] : '');
      });
      csvContent += row.join(',') + '\n';
    });

    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `correlation_raw_data_${correlationResults.type}_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 相関解析用のRスクリプトを生成
  const exportCorrelationRScript = () => {
    if (!correlationResults) return;

    const items = correlationResults.items;
    const corrType = correlationResults.type;

    const rScript = `# ============================================
# 相関解析 - Rスクリプト
# 生成日時: ${new Date().toLocaleString('ja-JP')}
# 相関係数タイプ: ${corrType === 'spearman' ? 'Spearman順位相関' : 'Pearson積率相関'}
# マーカー数: ${items.length}
# ============================================

# 必要なパッケージをインストール（未インストールの場合）
if (!require("corrplot")) install.packages("corrplot")
if (!require("Hmisc")) install.packages("Hmisc")
if (!require("ggplot2")) install.packages("ggplot2")
if (!require("reshape2")) install.packages("reshape2")

library(corrplot)
library(Hmisc)
library(ggplot2)
library(reshape2)

# データ読み込み
# ※ CSVファイルのパスを適宜変更してください
data <- read.csv("correlation_raw_data_${corrType}_${new Date().toISOString().split('T')[0]}.csv",
                 fileEncoding = "UTF-8-BOM", row.names = 1)

# データ確認
head(data)
dim(data)

# 数値データのみ抽出
numeric_data <- data[, sapply(data, is.numeric)]

# ============================================
# 相関行列の計算
# ============================================

# ${corrType === 'spearman' ? 'Spearman順位相関' : 'Pearson積率相関'}係数と p値
cor_result <- rcorr(as.matrix(numeric_data), type = "${corrType}")

# 相関係数行列
cor_matrix <- cor_result$r
print(round(cor_matrix, 3))

# p値行列
p_matrix <- cor_result$P
print(round(p_matrix, 4))

# サンプル数行列
n_matrix <- cor_result$n
print(n_matrix)

# 結果をCSVに保存
write.csv(round(cor_matrix, 4), "correlation_matrix_R.csv")
write.csv(round(p_matrix, 4), "correlation_pvalues_R.csv")

# ============================================
# 相関ヒートマップ（corrplot）
# ============================================

# 基本的なヒートマップ
png("correlation_heatmap_basic.png", width = 800, height = 800, res = 100)
corrplot(cor_matrix, method = "color", type = "full",
         tl.col = "black", tl.srt = 45,
         addCoef.col = "black", number.cex = 0.7,
         col = colorRampPalette(c("#3B82F6", "white", "#EF4444"))(200),
         title = "${corrType === 'spearman' ? 'Spearman' : 'Pearson'} Correlation Matrix",
         mar = c(0, 0, 2, 0))
dev.off()

# 有意な相関のみ表示（p < 0.05）
png("correlation_heatmap_significant.png", width = 800, height = 800, res = 100)
corrplot(cor_matrix, method = "color", type = "upper",
         tl.col = "black", tl.srt = 45,
         p.mat = p_matrix, sig.level = 0.05, insig = "blank",
         addCoef.col = "black", number.cex = 0.7,
         col = colorRampPalette(c("#3B82F6", "white", "#EF4444"))(200),
         title = "Significant Correlations (p < 0.05)",
         mar = c(0, 0, 2, 0))
dev.off()

# 階層的クラスタリング付き
png("correlation_heatmap_clustered.png", width = 900, height = 800, res = 100)
corrplot(cor_matrix, method = "color", type = "full",
         order = "hclust", addrect = 3,
         tl.col = "black", tl.srt = 45,
         addCoef.col = "black", number.cex = 0.6,
         col = colorRampPalette(c("#3B82F6", "white", "#EF4444"))(200),
         title = "Clustered Correlation Matrix",
         mar = c(0, 0, 2, 0))
dev.off()

# ============================================
# ggplot2版ヒートマップ
# ============================================

# 相関行列をlong formatに変換
cor_melted <- melt(cor_matrix)
p_melted <- melt(p_matrix)
cor_melted$p_value <- p_melted$value
cor_melted$sig <- ifelse(cor_melted$p_value < 0.001, "***",
                         ifelse(cor_melted$p_value < 0.01, "**",
                                ifelse(cor_melted$p_value < 0.05, "*", "")))

p_heatmap <- ggplot(cor_melted, aes(x = Var1, y = Var2, fill = value)) +
  geom_tile(color = "white") +
  geom_text(aes(label = paste0(round(value, 2), sig)), size = 3) +
  scale_fill_gradient2(low = "#3B82F6", mid = "white", high = "#EF4444",
                       midpoint = 0, limits = c(-1, 1),
                       name = "Correlation") +
  labs(title = "${corrType === 'spearman' ? 'Spearman' : 'Pearson'} Correlation Heatmap",
       x = "", y = "") +
  theme_minimal() +
  theme(axis.text.x = element_text(angle = 45, hjust = 1, vjust = 1),
        plot.title = element_text(hjust = 0.5, face = "bold"),
        panel.grid = element_blank()) +
  coord_fixed()

print(p_heatmap)
ggsave("correlation_heatmap_ggplot.png", p_heatmap, width = 10, height = 9, dpi = 300)

# ============================================
# 散布図マトリックス（オプション）
# ============================================

if (ncol(numeric_data) <= 6) {
  png("scatter_matrix.png", width = 1000, height = 1000, res = 100)
  pairs(numeric_data,
        lower.panel = function(x, y) {
          points(x, y, pch = 19, col = adjustcolor("blue", 0.5))
          abline(lm(y ~ x), col = "red", lwd = 2)
        },
        upper.panel = function(x, y) {
          r <- cor(x, y, use = "complete.obs", method = "${corrType}")
          text(mean(range(x, na.rm = TRUE)),
               mean(range(y, na.rm = TRUE)),
               paste0("r=", round(r, 2)), cex = 1.5)
        },
        main = "Scatter Plot Matrix")
  dev.off()
}

# ============================================
# 詳細な相関ペアリスト
# ============================================

# 全てのペアの相関係数をリスト化
pairs_list <- data.frame()
vars <- colnames(cor_matrix)
for (i in 1:(length(vars)-1)) {
  for (j in (i+1):length(vars)) {
    pairs_list <- rbind(pairs_list, data.frame(
      var1 = vars[i],
      var2 = vars[j],
      r = cor_matrix[i, j],
      p_value = p_matrix[i, j],
      n = n_matrix[i, j],
      abs_r = abs(cor_matrix[i, j])
    ))
  }
}

# 相関の強さでソート
pairs_list <- pairs_list[order(-pairs_list$abs_r), ]

cat("\\n=== 相関係数ランキング（|r|順）===\\n")
print(pairs_list[, c("var1", "var2", "r", "p_value", "n")])

# 保存
write.csv(pairs_list, "correlation_pairs_list.csv", row.names = FALSE)

cat("\\n解析完了！\\n")
`;

    const blob = new Blob([rScript], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `correlation_analysis_${corrType}_${items.length}markers.R`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ===== Rスクリプト・生データエクスポート関数 ここまで =====

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

  // 全検査データCSVエクスポート
  const exportAllLabDataCSV = async () => {
    if (!patients || patients.length === 0) {
      alert('エクスポートする患者データがありません');
      return;
    }

    setIsExporting(true);

    try {
      // CSVヘッダー
      let csv = 'patient_id,group,diagnosis,onset_date,lab_date,days_from_onset,specimen,item,value,unit\n';

      for (const patient of patients) {
        const onsetDate = patient.onsetDate ? new Date(patient.onsetDate) : null;

        const labQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
          orderBy('date', 'asc')
        );
        const labSnapshot = await getDocs(labQuery);

        labSnapshot.docs.forEach(labDoc => {
          const lab = labDoc.data();
          const labDate = lab.date ? new Date(lab.date) : null;
          let daysFromOnset = '';
          if (onsetDate && labDate) {
            daysFromOnset = Math.floor((labDate - onsetDate) / (1000 * 60 * 60 * 24));
          }

          // data配列形式
          if (lab.data && Array.isArray(lab.data)) {
            lab.data.forEach(item => {
              if (item.item && item.value !== undefined && item.value !== null && item.value !== '') {
                // 日付形式の項目名を除外
                if (/^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(item.item)) return;
                csv += `"${patient.displayId}","${patient.group || ''}","${patient.diagnosis || ''}","${patient.onsetDate || ''}","${lab.date || ''}","${daysFromOnset}","${lab.specimen || ''}","${item.item}","${item.value}","${item.unit || ''}"\n`;
              }
            });
          }

          // itemsオブジェクト形式
          if (lab.items && typeof lab.items === 'object') {
            Object.entries(lab.items).forEach(([itemName, itemData]) => {
              if (/^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(itemName)) return;
              if (itemName && itemData?.value !== undefined && itemData?.value !== null && itemData?.value !== '') {
                csv += `"${patient.displayId}","${patient.group || ''}","${patient.diagnosis || ''}","${patient.onsetDate || ''}","${lab.date || ''}","${daysFromOnset}","${lab.specimen || ''}","${itemName}","${itemData.value}","${itemData.unit || ''}"\n`;
              }
            });
          }
        });
      }

      // BOM付きでダウンロード
      const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
      const blob = new Blob([bom, csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `all_lab_data_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      alert(`検査データCSVをエクスポートしました（${patients.length}患者）`);
    } catch (err) {
      console.error('Error exporting lab data:', err);
      alert('エクスポート中にエラーが発生しました');
    } finally {
      setIsExporting(false);
    }
  };

  // 全臨床データCSVエクスポート（治療薬＋臨床イベント）
  const exportAllClinicalDataCSV = async () => {
    if (!patients || patients.length === 0) {
      alert('エクスポートする患者データがありません');
      return;
    }

    setIsExporting(true);

    try {
      // 治療薬CSV
      let treatmentCsv = 'patient_id,group,diagnosis,onset_date,treatment_name,category,start_date,end_date,start_day,end_day,dose,unit\n';

      // 臨床イベントCSV
      let eventCsv = 'patient_id,group,diagnosis,onset_date,event_type,start_date,end_date,start_day,end_day,input_type,jcs,frequency,severity,presence,note\n';

      for (const patient of patients) {
        const onsetDate = patient.onsetDate ? new Date(patient.onsetDate) : null;

        // 治療薬データ
        const treatmentQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'treatments'),
          orderBy('startDate', 'asc')
        );
        const treatmentSnapshot = await getDocs(treatmentQuery);

        treatmentSnapshot.docs.forEach(doc => {
          const t = doc.data();
          let startDay = '', endDay = '';
          if (onsetDate) {
            if (t.startDate) {
              startDay = Math.floor((new Date(t.startDate) - onsetDate) / (1000 * 60 * 60 * 24));
            }
            if (t.endDate) {
              endDay = Math.floor((new Date(t.endDate) - onsetDate) / (1000 * 60 * 60 * 24));
            }
          }
          treatmentCsv += `"${patient.displayId}","${patient.group || ''}","${patient.diagnosis || ''}","${patient.onsetDate || ''}","${t.name || ''}","${t.category || ''}","${t.startDate || ''}","${t.endDate || ''}","${startDay}","${endDay}","${t.dose || ''}","${t.unit || ''}"\n`;
        });

        // 臨床イベントデータ
        const eventQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
          orderBy('startDate', 'asc')
        );
        const eventSnapshot = await getDocs(eventQuery);

        eventSnapshot.docs.forEach(doc => {
          const e = doc.data();
          let startDay = '', endDay = '';
          if (onsetDate) {
            if (e.startDate) {
              startDay = Math.floor((new Date(e.startDate) - onsetDate) / (1000 * 60 * 60 * 24));
            }
            if (e.endDate) {
              endDay = Math.floor((new Date(e.endDate) - onsetDate) / (1000 * 60 * 60 * 24));
            }
          }
          eventCsv += `"${patient.displayId}","${patient.group || ''}","${patient.diagnosis || ''}","${patient.onsetDate || ''}","${e.eventType || ''}","${e.startDate || ''}","${e.endDate || ''}","${startDay}","${endDay}","${e.inputType || ''}","${e.jcs || ''}","${e.frequency || ''}","${e.severity || ''}","${e.presence || ''}","${(e.note || '').replace(/"/g, '""')}"\n`;
        });
      }

      // 治療薬CSVダウンロード
      const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
      const treatmentBlob = new Blob([bom, treatmentCsv], { type: 'text/csv;charset=utf-8' });
      const treatmentUrl = URL.createObjectURL(treatmentBlob);
      const a1 = document.createElement('a');
      a1.href = treatmentUrl;
      a1.download = `all_treatments_${new Date().toISOString().split('T')[0]}.csv`;
      a1.click();
      URL.revokeObjectURL(treatmentUrl);

      // 少し待ってから臨床イベントCSVダウンロード
      setTimeout(() => {
        const eventBlob = new Blob([bom, eventCsv], { type: 'text/csv;charset=utf-8' });
        const eventUrl = URL.createObjectURL(eventBlob);
        const a2 = document.createElement('a');
        a2.href = eventUrl;
        a2.download = `all_clinical_events_${new Date().toISOString().split('T')[0]}.csv`;
        a2.click();
        URL.revokeObjectURL(eventUrl);
      }, 500);

      alert(`臨床データCSVをエクスポートしました（${patients.length}患者）\n・治療薬データ\n・臨床イベントデータ`);
    } catch (err) {
      console.error('Error exporting clinical data:', err);
      alert('エクスポート中にエラーが発生しました');
    } finally {
      setIsExporting(false);
    }
  };

  // Kaplan-Meier用Tidy Dataエクスポート
  const exportKMData = async () => {
    if (!patients || patients.length === 0) {
      alert('エクスポートする患者データがありません');
      return;
    }

    if (!kmEventType) {
      alert('イベントタイプを選択してください');
      return;
    }

    if (kmSelectedGroups.length === 0) {
      alert('少なくとも1つの群を選択してください');
      return;
    }

    setIsExporting(true);

    try {
      // 打ち切り日（デフォルトは今日）
      const censorDate = kmCensorDate ? new Date(kmCensorDate) : new Date();

      // 対象患者をフィルタ
      const targetPatients = patients.filter(p => kmSelectedGroups.includes(p.group));

      // 各患者のイベントデータを取得
      const kmData = [];

      for (const patient of targetPatients) {
        const onsetDate = patient.onsetDate ? new Date(patient.onsetDate) : null;
        if (!onsetDate) continue; // 発症日がない患者はスキップ

        // 臨床イベントを取得
        const eventQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
          orderBy('startDate', 'asc')
        );
        const eventSnapshot = await getDocs(eventQuery);
        const events = eventSnapshot.docs.map(doc => doc.data());

        // 指定されたイベントタイプを検索
        const targetEvent = events.find(e => e.eventType === kmEventType);

        let time = 0;
        let status = 0; // 0 = censored, 1 = event

        if (targetEvent && targetEvent.startDate) {
          // イベントが発生した場合
          const eventDate = new Date(targetEvent.startDate);
          time = (eventDate - onsetDate) / (1000 * 60 * 60 * 24); // 日数
          status = 1;
        } else {
          // イベントが発生していない場合（打ち切り）
          time = (censorDate - onsetDate) / (1000 * 60 * 60 * 24);
          status = 0;
        }

        // 時間単位の変換
        if (kmTimeUnit === 'weeks') {
          time = time / 7;
        } else if (kmTimeUnit === 'months') {
          time = time / 30.44; // 平均月数
        }

        // 負の値は0に
        if (time < 0) time = 0;

        kmData.push({
          patient_id: patient.displayId,
          group: patient.group || '',
          diagnosis: patient.diagnosis || '',
          onset_date: patient.onsetDate || '',
          time: Math.round(time * 100) / 100, // 小数点2桁
          status: status,
          event_type: kmEventType,
          event_date: targetEvent?.startDate || '',
          censor_date: status === 0 ? kmCensorDate || new Date().toISOString().split('T')[0] : ''
        });
      }

      if (kmData.length === 0) {
        alert('対象となる患者データがありません（発症日が設定されている患者が必要です）');
        setIsExporting(false);
        return;
      }

      // CSVヘッダー
      let csv = 'patient_id,group,diagnosis,onset_date,time,status,event_type,event_date,censor_date\n';

      // データ行
      kmData.forEach(row => {
        csv += `"${row.patient_id}","${row.group}","${row.diagnosis}","${row.onset_date}",${row.time},${row.status},"${row.event_type}","${row.event_date}","${row.censor_date}"\n`;
      });

      // ダウンロード
      const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
      const blob = new Blob([bom, csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `km_survival_data_${kmEventType}_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      // Rスクリプトも同時に生成
      const timeUnitLabel = kmTimeUnit === 'days' ? '日' : kmTimeUnit === 'weeks' ? '週' : '月';
      const rScript = `# Kaplan-Meier Survival Analysis R Script
# Generated from Clinical Data Registry
# Event: ${kmEventType}
# Time unit: ${timeUnitLabel}
# Date: ${new Date().toISOString().split('T')[0]}

# Required packages
if (!require("survival")) install.packages("survival")
if (!require("survminer")) install.packages("survminer")
if (!require("ggplot2")) install.packages("ggplot2")

library(survival)
library(survminer)
library(ggplot2)

# Load data (Note: using 'surv_data' to avoid conflict with R's data() function)
surv_data <- read.csv("km_survival_data_${kmEventType}_${new Date().toISOString().split('T')[0]}.csv",
                      fileEncoding = "UTF-8-BOM")

# Check data structure
str(surv_data)
summary(surv_data)
table(surv_data$group, surv_data$status)  # Event counts by group

# Create survival object
surv_obj <- Surv(time = surv_data$time, event = surv_data$status)

# Fit Kaplan-Meier model
km_fit <- survfit(surv_obj ~ group, data = surv_data)

# Summary statistics
print(km_fit)
summary(km_fit)

# Kaplan-Meier Plot
km_plot <- ggsurvplot(
  km_fit,
  data = surv_data,
  pval = TRUE,                    # Show p-value (log-rank test)
  conf.int = TRUE,                # Show confidence intervals
  risk.table = TRUE,              # Show risk table
  risk.table.col = "strata",
  linetype = "strata",
  surv.median.line = "hv",        # Show median survival
  ggtheme = theme_bw(),
  palette = c("#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F"),  # Nature palette
  xlab = "Time (${timeUnitLabel})",
  ylab = "Survival Probability",
  title = "Kaplan-Meier Survival Curve: ${kmEventType}",
  legend.title = "Group",
  legend.labs = unique(surv_data$group),
  font.main = c(14, "bold"),
  font.x = c(12, "plain"),
  font.y = c(12, "plain"),
  font.tickslab = c(10, "plain")
)

# Display plot
print(km_plot)

# Save plot
ggsave("km_curve_${kmEventType}.png",
       plot = print(km_plot),
       width = 10,
       height = 8,
       dpi = 300)

# Log-rank test (detailed)
log_rank <- survdiff(surv_obj ~ group, data = surv_data)
print(log_rank)

# Cox proportional hazards model (optional)
cox_model <- coxph(surv_obj ~ group, data = surv_data)
summary(cox_model)

# Hazard ratios with confidence intervals
exp(confint(cox_model))
`;

      setTimeout(() => {
        const rBlob = new Blob([rScript], { type: 'text/plain;charset=utf-8' });
        const rUrl = URL.createObjectURL(rBlob);
        const a2 = document.createElement('a');
        a2.href = rUrl;
        a2.download = `km_analysis_${kmEventType}_${new Date().toISOString().split('T')[0]}.R`;
        a2.click();
        URL.revokeObjectURL(rUrl);
      }, 500);

      const eventCount = kmData.filter(d => d.status === 1).length;
      const censoredCount = kmData.filter(d => d.status === 0).length;
      alert(`KM解析用データをエクスポートしました\n\n患者数: ${kmData.length}\nイベント発生: ${eventCount}\n打ち切り: ${censoredCount}\n\n・CSVデータファイル\n・R解析スクリプト`);

      setShowKMExportModal(false);
    } catch (err) {
      console.error('Error exporting KM data:', err);
      alert('エクスポート中にエラーが発生しました');
    } finally {
      setIsExporting(false);
    }
  };

  // Kaplan-Meier曲線データ生成（アプリ内描画用）
  const generateKMChartData = async () => {
    if (!kmChartEventType || !kmChartGroup1 || !kmChartGroup2) {
      alert('イベントタイプと2つの群を選択してください');
      return;
    }

    setKmChartLoading(true);

    try {
      const censorDate = kmChartCensorDate ? new Date(kmChartCensorDate) : new Date();
      const targetPatients = patients.filter(p => p.group === kmChartGroup1 || p.group === kmChartGroup2);

      const survivalData = [];

      for (const patient of targetPatients) {
        const onsetDate = patient.onsetDate ? new Date(patient.onsetDate) : null;
        if (!onsetDate) continue;

        const eventQuery = query(
          collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
          orderBy('startDate', 'asc')
        );
        const eventSnapshot = await getDocs(eventQuery);
        const events = eventSnapshot.docs.map(doc => doc.data());
        const targetEvent = events.find(e => e.eventType === kmChartEventType);

        let time = 0;
        let status = 0;

        if (targetEvent && targetEvent.startDate) {
          const eventDate = new Date(targetEvent.startDate);
          time = (eventDate - onsetDate) / (1000 * 60 * 60 * 24);
          status = 1;
        } else {
          time = (censorDate - onsetDate) / (1000 * 60 * 60 * 24);
          status = 0;
        }

        if (kmChartTimeUnit === 'weeks') time = time / 7;
        else if (kmChartTimeUnit === 'months') time = time / 30.44;

        if (time < 0) time = 0;

        survivalData.push({
          patientId: patient.displayId,
          group: patient.group,
          time: Math.round(time * 100) / 100,
          status
        });
      }

      // Kaplan-Meier推定値を計算
      const calculateKM = (data) => {
        const sorted = [...data].sort((a, b) => a.time - b.time);
        const n = sorted.length;
        let atRisk = n;
        let survival = 1;
        const curve = [{ time: 0, survival: 1, atRisk: n }];

        sorted.forEach((d, i) => {
          if (d.status === 1) {
            survival = survival * ((atRisk - 1) / atRisk);
            curve.push({ time: d.time, survival, atRisk, event: true });
          } else {
            curve.push({ time: d.time, survival, atRisk, censored: true });
          }
          atRisk--;
        });

        return curve;
      };

      const group1Data = survivalData.filter(d => d.group === kmChartGroup1);
      const group2Data = survivalData.filter(d => d.group === kmChartGroup2);

      const curve1 = calculateKM(group1Data);
      const curve2 = calculateKM(group2Data);

      // Log-rank検定（簡易版）
      const logRankTest = () => {
        const allTimes = [...new Set(survivalData.filter(d => d.status === 1).map(d => d.time))].sort((a, b) => a - b);

        let O1 = 0, E1 = 0, V = 0;

        allTimes.forEach(t => {
          const n1 = group1Data.filter(d => d.time >= t).length;
          const n2 = group2Data.filter(d => d.time >= t).length;
          const n = n1 + n2;
          if (n === 0) return;

          const d1 = group1Data.filter(d => d.time === t && d.status === 1).length;
          const d2 = group2Data.filter(d => d.time === t && d.status === 1).length;
          const d = d1 + d2;

          const e1 = (n1 * d) / n;
          O1 += d1;
          E1 += e1;

          if (n > 1) {
            V += (n1 * n2 * d * (n - d)) / (n * n * (n - 1));
          }
        });

        if (V === 0) return { chi2: null, pValue: null };

        const chi2 = Math.pow(O1 - E1, 2) / V;
        // 近似p値（カイ二乗分布、自由度1）
        const pValue = 1 - (1 - Math.exp(-chi2 / 2));

        return { chi2, pValue: Math.max(0.001, Math.min(1, pValue)) };
      };

      const logRank = logRankTest();

      setKmChartData({
        group1: { name: kmChartGroup1, data: group1Data, curve: curve1 },
        group2: { name: kmChartGroup2, data: group2Data, curve: curve2 },
        logRank,
        maxTime: Math.max(...survivalData.map(d => d.time)),
        eventType: kmChartEventType
      });

    } catch (err) {
      console.error('Error generating KM chart:', err);
      alert('KM曲線の生成中にエラーが発生しました');
    } finally {
      setKmChartLoading(false);
    }
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
    // サンプル選択関連のリセット
    setSampleSelectionMode('all');
    setTargetDay('');
    setSampleDetails(null);
    setDayRangeStart('');
    setDayRangeEnd('');

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

  // 患者ごとに1サンプルを選択するヘルパー関数
  const selectOnePerPatient = (dataArray, mode, targetDayNum) => {
    if (!dataArray || !Array.isArray(dataArray) || dataArray.length === 0) {
      return [];
    }
    // 患者IDでグループ化
    const byPatient = {};
    dataArray.forEach(d => {
      if (!d || d.id === undefined || d.id === null) return;
      if (!byPatient[d.id]) byPatient[d.id] = [];
      byPatient[d.id].push(d);
    });

    const selected = [];
    Object.entries(byPatient).forEach(([patientId, samples]) => {
      if (!samples || samples.length === 0) return;
      if (mode === 'first') {
        // 最初のサンプル
        samples.sort((a, b) => (a.day ?? 0) - (b.day ?? 0));
        selected.push(samples[0]);
      } else if (mode === 'last') {
        // 最後のサンプル
        samples.sort((a, b) => (b.day ?? 0) - (a.day ?? 0));
        selected.push(samples[0]);
      } else if (mode === 'closest') {
        // 指定日に最も近いサンプル
        const target = parseInt(targetDayNum) || 0;
        samples.sort((a, b) => Math.abs((a.day ?? 0) - target) - Math.abs((b.day ?? 0) - target));
        selected.push(samples[0]);
      }
    });
    return selected;
  };

  // サンプル詳細を計算
  const calculateSampleDetails = (dataArray) => {
    if (!dataArray || !Array.isArray(dataArray)) {
      return { uniquePatients: 0, totalSamples: 0, patientsWithMultiple: 0, byPatient: {} };
    }
    const byPatient = {};
    dataArray.forEach(d => {
      if (!d || d.id === undefined || d.id === null) return;
      if (!byPatient[d.id]) byPatient[d.id] = { count: 0, days: [] };
      byPatient[d.id].count++;
      byPatient[d.id].days.push(d.day ?? null);
    });

    const uniquePatients = Object.keys(byPatient).length;
    const totalSamples = dataArray.length;
    const patientsWithMultiple = Object.values(byPatient).filter(p => p && p.count > 1).length;

    return {
      uniquePatients,
      totalSamples,
      patientsWithMultiple,
      byPatient
    };
  };

  const runGroupComparison = async () => {
    if (!selectedGroup1 || !selectedGroup2 || selectedItems.length === 0) {
      alert('2つの群と検査項目を選択してください');
      return;
    }

    setIsLoadingAnalysis(true);
    setSampleDetails(null);

    const group1Patients = patients.filter(p => p.group === selectedGroup1);
    const group2Patients = patients.filter(p => p.group === selectedGroup2);

    const results = [];
    const allSampleDetails = { group1: null, group2: null };

    for (const itemName of selectedItems) {
      let group1Data = []; // { id, value, date, day }
      let group2Data = []; // { id, value, date, day }

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

      // サンプル詳細を計算（1つ目の検査項目で計算）
      if (results.length === 0) {
        allSampleDetails.group1 = calculateSampleDetails(group1Data);
        allSampleDetails.group2 = calculateSampleDetails(group2Data);
      }

      // 1患者1サンプルモードの場合、選択を適用
      if (sampleSelectionMode !== 'all') {
        group1Data = selectOnePerPatient(group1Data, sampleSelectionMode, targetDay);
        group2Data = selectOnePerPatient(group2Data, sampleSelectionMode, targetDay);
      }

      // 数値のみの配列を抽出（統計計算用）
      const group1Values = group1Data.map(d => d.value);
      const group2Values = group2Data.map(d => d.value);

      if (group1Values.length > 0 && group2Values.length > 0) {
        const tResult = tTest(group1Values, group2Values);
        const mwResult = mannWhitneyU(group1Values, group2Values);

        // 患者数をカウント
        const group1UniquePatients = new Set(group1Data.map(d => d.id)).size;
        const group2UniquePatients = new Set(group2Data.map(d => d.id)).size;

        results.push({
          item: itemName,
          group1: {
            n: group1Values.length,
            nPatients: group1UniquePatients,
            mean: mean(group1Values).toFixed(2),
            std: group1Values.length > 1 ? std(group1Values).toFixed(2) : '-',
            median: [...group1Values].sort((a, b) => a - b)[Math.floor(group1Values.length / 2)].toFixed(2),
            values: [...group1Values],
            data: [...group1Data] // ID付きデータも保存
          },
          group2: {
            n: group2Values.length,
            nPatients: group2UniquePatients,
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

    setSampleDetails(allSampleDetails);
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
          {/* 組織セレクター（複数組織所属時のみ表示） */}
          {organizations.length > 1 && (
            <select
              value={currentOrg?.id || ''}
              onChange={(e) => switchOrganization(e.target.value)}
              style={{
                marginLeft: '16px',
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid #d1d5db',
                fontSize: '13px',
                backgroundColor: '#f0f9ff',
                color: '#1e40af',
                fontWeight: '500',
                cursor: 'pointer'
              }}
            >
              {organizations.map(org => (
                <option key={org.id} value={org.id}>
                  {org.name} {org.tier === 'free' ? '(無料)' : ''}
                </option>
              ))}
            </select>
          )}
          {/* 単一組織の場合は名前のみ表示 */}
          {organizations.length === 1 && currentOrg && (
            <span style={{
              marginLeft: '16px',
              padding: '4px 10px',
              borderRadius: '4px',
              backgroundColor: '#dbeafe',
              color: '#1e40af',
              fontSize: '12px',
              fontWeight: '500'
            }}>
              {currentOrg.name}
            </span>
          )}
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
              color: '#ffffff',
              fontSize: '14px',
              fontWeight: '600',
              marginRight: '8px',
              textDecoration: 'none',
              display: 'inline-block'
            }}
          >
            📖 操作ガイド
          </a>
          {/* システム管理ボタン（システム管理者のみ） */}
          {isSystemAdmin && (
            <button
              onClick={() => setShowSystemAdminPanel(true)}
              style={{
                ...styles.logoutButton,
                backgroundColor: '#dc2626',
                color: '#ffffff',
                fontSize: '14px',
                fontWeight: '600',
                marginRight: '8px'
              }}
            >
              🔧 システム管理
            </button>
          )}
          {(isAdmin || !adminEmail) && (
            <button
              onClick={() => setShowAdminPanel(true)}
              style={{
                ...styles.logoutButton,
                backgroundColor: '#7c3aed',
                color: '#ffffff',
                fontSize: '14px',
                fontWeight: '600',
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
        {/* 機能セクション */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '16px',
          marginBottom: '24px'
        }}>
          {/* データ登録セクション - 水色 */}
          <div style={{
            background: '#e0f2fe',
            borderRadius: '8px',
            padding: '16px',
            border: '1px solid #7dd3fc',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
          }}>
            <h3 style={{
              fontSize: '13px',
              fontWeight: '600',
              color: '#0369a1',
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              borderBottom: '2px solid #0369a1',
              paddingBottom: '8px'
            }}>
              データ登録
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button onClick={() => setShowAddModal(true)} style={{
                ...styles.addButton,
                backgroundColor: '#0284c7',
                width: '100%',
                justifyContent: 'center'
              }}>
                <span style={styles.addIcon}>+</span>
                新規患者登録
              </button>
              <button
                onClick={() => setShowBulkImportModal(true)}
                style={{
                  ...styles.addButton,
                  backgroundColor: '#0369a1',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                患者一括登録（CSV）
              </button>
              <button
                onClick={() => setShowBulkLabImportModal(true)}
                style={{
                  ...styles.addButton,
                  backgroundColor: '#075985',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                データ一括登録
              </button>
            </div>
          </div>

          {/* 統計・可視化セクション - 白 */}
          <div style={{
            background: '#ffffff',
            borderRadius: '8px',
            padding: '16px',
            border: '1px solid #d1d5db',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
          }}>
            <h3 style={{
              fontSize: '13px',
              fontWeight: '600',
              color: '#1f2937',
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              borderBottom: '2px solid #1f2937',
              paddingBottom: '8px'
            }}>
              統計・可視化
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                onClick={openAnalysisModal}
                disabled={patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#1f2937',
                  cursor: patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                経時データ分析
              </button>
              <button
                onClick={() => {
                  setShowSwimmerPlot(true);
                  runSwimmerPlot();
                }}
                disabled={patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#374151',
                  cursor: patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                Swimmer Plot
              </button>
              <button
                onClick={openAnalysisModal}
                disabled={patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#4b5563',
                  cursor: patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                群間比較
              </button>
              <button
                onClick={() => {
                  setShowSpaghettiPlot(true);
                  generateSpaghettiData();
                }}
                disabled={patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#52525b',
                  cursor: patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                スパゲッティプロット
              </button>
              <button
                onClick={() => {
                  setShowHeatmap(true);
                  generateHeatmapData();
                }}
                disabled={patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#44403c',
                  cursor: patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                ヒートマップ
              </button>
              <button
                onClick={async () => {
                  setKmChartData(null);
                  setKmChartEventType('');
                  setKmChartGroup1('');
                  setKmChartGroup2('');
                  setShowKMChart(true);

                  // イベントタイプを取得
                  setKmLoadingEventTypes(true);
                  try {
                    const eventTypesSet = new Set();
                    for (const patient of patients) {
                      const eventQuery = query(
                        collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents')
                      );
                      const eventSnapshot = await getDocs(eventQuery);
                      eventSnapshot.docs.forEach(doc => {
                        const eventType = doc.data().eventType;
                        if (eventType) eventTypesSet.add(eventType);
                      });
                    }
                    setKmAvailableEventTypes(Array.from(eventTypesSet).sort());
                  } catch (err) {
                    console.error('Error fetching event types:', err);
                  } finally {
                    setKmLoadingEventTypes(false);
                  }
                }}
                disabled={patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#1e3a5f',
                  cursor: patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                Kaplan-Meier曲線
              </button>
            </div>
          </div>

          {/* データエクスポートセクション - 灰色 */}
          <div style={{
            background: '#f3f4f6',
            borderRadius: '8px',
            padding: '16px',
            border: '1px solid #9ca3af',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
          }}>
            <h3 style={{
              fontSize: '13px',
              fontWeight: '600',
              color: '#4b5563',
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              borderBottom: '2px solid #4b5563',
              paddingBottom: '8px'
            }}>
              データエクスポート
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                onClick={exportAllData}
                disabled={isExporting || patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#6b7280',
                  opacity: isExporting ? 0.7 : 1,
                  cursor: isExporting || patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                {isExporting ? 'エクスポート中...' : '患者一覧CSV'}
              </button>
              <button
                onClick={exportAllLabDataCSV}
                disabled={isExporting || patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#4b5563',
                  opacity: isExporting ? 0.7 : 1,
                  cursor: isExporting || patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                全検査データCSV
              </button>
              <button
                onClick={exportAllClinicalDataCSV}
                disabled={isExporting || patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#374151',
                  opacity: isExporting ? 0.7 : 1,
                  cursor: isExporting || patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                全臨床データCSV
              </button>
              <button
                onClick={async () => {
                  // 群のリストを取得
                  const groups = [...new Set(patients.map(p => p.group).filter(g => g))];
                  setKmSelectedGroups(groups);
                  setKmEventType('');
                  setShowKMExportModal(true);

                  // 実際に登録されているイベントタイプを取得
                  setKmLoadingEventTypes(true);
                  try {
                    const eventTypesSet = new Set();
                    for (const patient of patients) {
                      const eventQuery = query(
                        collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents')
                      );
                      const eventSnapshot = await getDocs(eventQuery);
                      eventSnapshot.docs.forEach(doc => {
                        const eventType = doc.data().eventType;
                        if (eventType) eventTypesSet.add(eventType);
                      });
                    }
                    setKmAvailableEventTypes(Array.from(eventTypesSet).sort());
                  } catch (err) {
                    console.error('Error fetching event types:', err);
                  } finally {
                    setKmLoadingEventTypes(false);
                  }
                }}
                disabled={patients.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: patients.length === 0 ? '#d1d5db' : '#1e3a5f',
                  cursor: patients.length === 0 ? 'not-allowed' : 'pointer',
                  width: '100%',
                  justifyContent: 'center'
                }}
              >
                KM曲線用データ
              </button>
            </div>
          </div>
        </div>

        {/* 患者データセクション */}
        <div style={{
          background: '#ffffff',
          borderRadius: '8px',
          padding: '20px',
          border: '1px solid #e5e7eb',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
        }}>
          <h3 style={{
            fontSize: '14px',
            fontWeight: '600',
            color: '#1f2937',
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '2px solid #1f2937',
            paddingBottom: '10px'
          }}>
            <span>患者データ</span>
            <span style={{
              fontSize: '12px',
              fontWeight: '400',
              color: '#6b7280'
            }}>
              {patients.length} 件登録
            </span>
          </h3>

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
        </div>
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

                          {/* サンプル選択モード */}
                          <div style={{
                            padding: '12px',
                            background: '#fef3c7',
                            borderRadius: '8px',
                            marginBottom: '16px',
                            border: '1px solid #fcd34d'
                          }}>
                            <label style={{...styles.inputLabel, marginBottom: '8px', display: 'block'}}>
                              🔬 サンプル選択モード
                            </label>
                            <div style={{display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center'}}>
                              <label style={{display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '13px'}}>
                                <input
                                  type="radio"
                                  name="sampleMode"
                                  checked={sampleSelectionMode === 'all'}
                                  onChange={() => setSampleSelectionMode('all')}
                                />
                                全サンプル
                              </label>
                              <label style={{display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '13px'}}>
                                <input
                                  type="radio"
                                  name="sampleMode"
                                  checked={sampleSelectionMode === 'first'}
                                  onChange={() => setSampleSelectionMode('first')}
                                />
                                最初の1点/患者
                              </label>
                              <label style={{display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '13px'}}>
                                <input
                                  type="radio"
                                  name="sampleMode"
                                  checked={sampleSelectionMode === 'last'}
                                  onChange={() => setSampleSelectionMode('last')}
                                />
                                最後の1点/患者
                              </label>
                              <label style={{display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '13px'}}>
                                <input
                                  type="radio"
                                  name="sampleMode"
                                  checked={sampleSelectionMode === 'closest'}
                                  onChange={() => setSampleSelectionMode('closest')}
                                />
                                指定日に最も近い
                              </label>
                              {sampleSelectionMode === 'closest' && (
                                <div style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                                  <span style={{fontSize: '12px'}}>Day</span>
                                  <input
                                    type="number"
                                    value={targetDay}
                                    onChange={(e) => setTargetDay(e.target.value)}
                                    style={{...styles.input, width: '60px', padding: '4px 8px'}}
                                    placeholder="0"
                                  />
                                </div>
                              )}
                            </div>
                            <p style={{fontSize: '11px', color: '#92400e', marginTop: '8px', marginBottom: 0}}>
                              ⚠️ 「全サンプル」は同一患者の複数データが含まれる可能性があります（独立性の仮定に注意）
                            </p>
                          </div>

                          <p style={{fontSize: '12px', color: '#6b7280', marginBottom: '12px'}}>
                            ※ 上で選択した検査項目について、2群間の統計比較を行います
                            {(dayRangeStart !== '' || dayRangeEnd !== '') && (
                              <span style={{color: '#7c3aed', fontWeight: '500'}}>
                                （Day {dayRangeStart || '?'} 〜 {dayRangeEnd || '?'} のみ）
                              </span>
                            )}
                            {sampleSelectionMode !== 'all' && (
                              <span style={{color: '#b45309', fontWeight: '500'}}>
                                　・1患者1サンプル（{sampleSelectionMode === 'first' ? '最初' : sampleSelectionMode === 'last' ? '最後' : `Day ${targetDay || 0}に最も近い`}）
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

                          {/* サンプル詳細表示 */}
                          {sampleDetails && (
                            <div style={{
                              marginTop: '16px',
                              padding: '12px',
                              background: sampleSelectionMode === 'all' && (sampleDetails.group1?.patientsWithMultiple > 0 || sampleDetails.group2?.patientsWithMultiple > 0)
                                ? '#fef2f2' : '#f0fdf4',
                              borderRadius: '8px',
                              border: `1px solid ${sampleSelectionMode === 'all' && (sampleDetails.group1?.patientsWithMultiple > 0 || sampleDetails.group2?.patientsWithMultiple > 0) ? '#fecaca' : '#bbf7d0'}`
                            }}>
                              <div style={{fontWeight: '600', fontSize: '13px', marginBottom: '8px', color: '#1f2937'}}>
                                📊 サンプル詳細
                              </div>
                              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', fontSize: '12px'}}>
                                <div>
                                  <div style={{fontWeight: '500', color: '#6b7280', marginBottom: '4px'}}>{selectedGroup1}</div>
                                  <div>患者数: <strong>{sampleDetails.group1?.uniquePatients || 0}</strong>人</div>
                                  <div>総サンプル数: <strong>{sampleDetails.group1?.totalSamples || 0}</strong>件</div>
                                  {sampleDetails.group1?.patientsWithMultiple > 0 && (
                                    <div style={{color: '#dc2626', marginTop: '4px'}}>
                                      ⚠️ 複数サンプル患者: {sampleDetails.group1.patientsWithMultiple}人
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <div style={{fontWeight: '500', color: '#6b7280', marginBottom: '4px'}}>{selectedGroup2}</div>
                                  <div>患者数: <strong>{sampleDetails.group2?.uniquePatients || 0}</strong>人</div>
                                  <div>総サンプル数: <strong>{sampleDetails.group2?.totalSamples || 0}</strong>件</div>
                                  {sampleDetails.group2?.patientsWithMultiple > 0 && (
                                    <div style={{color: '#dc2626', marginTop: '4px'}}>
                                      ⚠️ 複数サンプル患者: {sampleDetails.group2.patientsWithMultiple}人
                                    </div>
                                  )}
                                </div>
                              </div>
                              {sampleSelectionMode === 'all' && (sampleDetails.group1?.patientsWithMultiple > 0 || sampleDetails.group2?.patientsWithMultiple > 0) && (
                                <div style={{
                                  marginTop: '12px',
                                  padding: '8px',
                                  background: '#fee2e2',
                                  borderRadius: '4px',
                                  fontSize: '11px',
                                  color: '#b91c1c'
                                }}>
                                  <strong>統計的注意:</strong> 同一患者から複数サンプルが含まれています。
                                  独立性の仮定が満たされない可能性があります。
                                  「1患者1サンプル」モードの使用を検討してください。
                                </div>
                              )}
                              {sampleSelectionMode !== 'all' && (
                                <div style={{
                                  marginTop: '8px',
                                  fontSize: '11px',
                                  color: '#166534'
                                }}>
                                  ✓ 1患者1サンプルモード適用済み（独立性の仮定を満たします）
                                </div>
                              )}
                            </div>
                          )}

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
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}} title="サンプル数 (患者数)">n (pts)</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>Mean±SD</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>Median</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}} title="サンプル数 (患者数)">n (pts)</th>
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
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>
                                          {r.group1.n}
                                          {r.group1.nPatients && r.group1.nPatients !== r.group1.n && (
                                            <span style={{fontSize: '10px', color: '#6b7280'}}> ({r.group1.nPatients})</span>
                                          )}
                                        </td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>{r.group1.mean}±{r.group1.std}</td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>{r.group1.median}</td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>
                                          {r.group2.n}
                                          {r.group2.nPatients && r.group2.nPatients !== r.group2.n && (
                                            <span style={{fontSize: '10px', color: '#6b7280'}}> ({r.group2.nPatients})</span>
                                          )}
                                        </td>
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
                              <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '12px'}}>
                                <button
                                  onClick={exportComparisonCSV}
                                  style={{
                                    ...styles.addButton,
                                    backgroundColor: '#28a745',
                                    padding: '8px 16px',
                                    fontSize: '13px'
                                  }}
                                >
                                  📊 統計結果CSV
                                </button>
                                <button
                                  onClick={exportGroupComparisonRawData}
                                  style={{
                                    ...styles.addButton,
                                    backgroundColor: '#2563eb',
                                    padding: '8px 16px',
                                    fontSize: '13px'
                                  }}
                                >
                                  📥 生データCSV
                                </button>
                                <button
                                  onClick={exportGroupComparisonRScript}
                                  style={{
                                    ...styles.addButton,
                                    backgroundColor: '#7c3aed',
                                    padding: '8px 16px',
                                    fontSize: '13px'
                                  }}
                                >
                                  📜 Rスクリプト
                                </button>
                              </div>

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

                                {/* 学術誌スタイル設定 */}
                                <div style={{
                                  padding: '12px',
                                  background: '#f0fdf4',
                                  borderRadius: '8px',
                                  border: '1px solid #bbf7d0',
                                  marginBottom: '16px'
                                }}>
                                  <h5 style={{margin: '0 0 10px 0', fontSize: '13px', color: '#166534'}}>
                                    📊 学術誌スタイル設定
                                  </h5>

                                  {/* カラーパレット */}
                                  <div style={{display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap', alignItems: 'center'}}>
                                    <label style={{fontSize: '12px', color: '#374151', minWidth: '80px'}}>カラー:</label>
                                    <select
                                      value={chartColorPalette}
                                      onChange={(e) => setChartColorPalette(e.target.value)}
                                      style={{
                                        padding: '4px 8px',
                                        fontSize: '12px',
                                        borderRadius: '4px',
                                        border: '1px solid #d1d5db',
                                        background: 'white',
                                        cursor: 'pointer'
                                      }}
                                    >
                                      {Object.entries(journalColorPalettes).map(([key, palette]) => (
                                        <option key={key} value={key}>
                                          {palette.name} - {palette.description}
                                        </option>
                                      ))}
                                    </select>
                                    {/* カラープレビュー */}
                                    <div style={{display: 'flex', gap: '2px'}}>
                                      {journalColorPalettes[chartColorPalette]?.colors.slice(0, 4).map((color, i) => (
                                        <div key={i} style={{
                                          width: '16px',
                                          height: '16px',
                                          backgroundColor: color,
                                          borderRadius: '2px',
                                          border: '1px solid #e5e7eb'
                                        }}/>
                                      ))}
                                    </div>
                                  </div>

                                  {/* フォント */}
                                  <div style={{display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap', alignItems: 'center'}}>
                                    <label style={{fontSize: '12px', color: '#374151', minWidth: '80px'}}>フォント:</label>
                                    <select
                                      value={chartFontFamily}
                                      onChange={(e) => setChartFontFamily(e.target.value)}
                                      style={{
                                        padding: '4px 8px',
                                        fontSize: '12px',
                                        borderRadius: '4px',
                                        border: '1px solid #d1d5db',
                                        background: 'white',
                                        cursor: 'pointer'
                                      }}
                                    >
                                      {Object.entries(chartFontOptions).map(([key, font]) => (
                                        <option key={key} value={key}>
                                          {font.name} ({font.description})
                                        </option>
                                      ))}
                                    </select>
                                  </div>

                                  {/* 出力解像度 */}
                                  <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center'}}>
                                    <label style={{fontSize: '12px', color: '#374151', minWidth: '80px'}}>解像度:</label>
                                    {chartDpiOptions.map(opt => (
                                      <label key={opt.value} style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '4px',
                                        padding: '4px 8px',
                                        background: chartExportDpi === opt.value ? '#166534' : 'white',
                                        color: chartExportDpi === opt.value ? 'white' : '#374151',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        border: '1px solid #d1d5db',
                                        fontSize: '11px'
                                      }}>
                                        <input
                                          type="radio"
                                          name="chartDpi"
                                          value={opt.value}
                                          checked={chartExportDpi === opt.value}
                                          onChange={() => setChartExportDpi(opt.value)}
                                          style={{display: 'none'}}
                                        />
                                        {opt.label}
                                      </label>
                                    ))}
                                  </div>
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
                                    if (!stats1 || !stats2) return null; // データ不足の場合はnullを返してフィルタリング

                                    // 正規性検定
                                    const norm1 = shapiroWilkTest(result.group1.values);
                                    const norm2 = shapiroWilkTest(result.group2.values);
                                    const bothNormal = norm1.isNormal && norm2.isNormal;

                                    // 適切な検定を選択
                                    const testResult = bothNormal
                                      ? tTest(result.group1.values, result.group2.values)
                                      : mannWhitneyU(result.group1.values, result.group2.values);
                                    const pValue = testResult.pValue ?? 1; // nullの場合は1（有意差なし）
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

                                  // 学術誌スタイル設定を適用
                                  const currentFont = chartFontOptions[chartFontFamily]?.css || 'Arial, sans-serif';
                                  const color1 = getPaletteColor(0);
                                  const color2 = getPaletteColor(1);

                                  let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="font-family: ${currentFont};">`;
                                  svgContent += `<rect width="100%" height="100%" fill="white"/>`;

                                  // タイトル（8pt bold - Nature style）
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

                                  drawBox(stats1, x1, color1);
                                  drawBox(stats2, x2, color2);

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
                                    return <div style={{padding: '20px', color: '#6b7280'}}>選択した項目に十分なデータ数がないため統計が出力できません</div>;
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

                                            // DPI設定に基づくスケール計算
                                            const scale = chartExportDpi / 96; // 96 = 標準スクリーンDPI
                                            const canvas = document.createElement('canvas');
                                            canvas.width = totalWidth * scale;
                                            canvas.height = totalHeight * scale;
                                            const ctx = canvas.getContext('2d');
                                            ctx.scale(scale, scale);
                                            const img = new Image();
                                            img.onload = () => {
                                              ctx.fillStyle = 'white';
                                              ctx.fillRect(0, 0, totalWidth, totalHeight);
                                              ctx.drawImage(img, 0, 0);
                                              const pngUrl = canvas.toDataURL('image/png');
                                              const a = document.createElement('a');
                                              a.href = pngUrl;
                                              a.download = `統計グラフ_${statChartType}_${chartDataList.length}項目_${chartExportDpi}dpi.png`;
                                              a.click();
                                            };
                                            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(combinedSvg);
                                          }}
                                          style={{...styles.addButton, backgroundColor: '#0ea5e9', padding: '10px 20px', fontSize: '13px'}}
                                        >
                                          📷 PNG保存 ({chartExportDpi}dpi)
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
                              選択した項目に十分なデータ数がないため統計が出力できません。
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>

                {/* ROC曲線解析セクション */}
                <div style={{
                  marginTop: '30px',
                  padding: '20px',
                  background: '#fdf4ff',
                  borderRadius: '12px',
                  border: '1px solid #f0abfc'
                }}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px'}}>
                    <h3 style={{margin: 0, color: '#a21caf', fontSize: '16px'}}>📈 ROC曲線解析</h3>
                    <button
                      onClick={() => setShowRocAnalysis(!showRocAnalysis)}
                      style={{
                        background: showRocAnalysis ? '#a21caf' : 'white',
                        color: showRocAnalysis ? 'white' : '#a21caf',
                        border: '1px solid #a21caf',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px'
                      }}
                    >
                      {showRocAnalysis ? '閉じる' : '開く'}
                    </button>
                  </div>

                  {showRocAnalysis && (
                    <>
                      {availableGroups.length < 2 ? (
                        <div style={{padding: '20px', textAlign: 'center', color: '#6b7280'}}>
                          ROC解析には2つの群が必要です。<br/>
                          患者登録時に「群」を設定してください。
                        </div>
                      ) : (
                        <>
                          {/* 群が選択されていない場合の警告 */}
                          {(!selectedGroup1 || !selectedGroup2) && (
                            <div style={{
                              padding: '12px',
                              background: '#fef3c7',
                              borderRadius: '8px',
                              marginBottom: '16px',
                              border: '1px solid #fcd34d',
                              fontSize: '13px',
                              color: '#92400e'
                            }}>
                              ⚠️ 先に「📊 群間統計比較」セクションで<strong>群1と群2を選択</strong>してください。
                            </div>
                          )}

                          <p style={{fontSize: '12px', color: '#6b7280', marginBottom: '16px'}}>
                            群1を<strong>陰性（コントロール）</strong>、群2を<strong>陽性（疾患）</strong>として解析します。
                            {selectedGroup1 && selectedGroup2 && (
                              <span style={{marginLeft: '8px', color: '#a21caf'}}>
                                （{selectedGroup1} vs {selectedGroup2}）
                              </span>
                            )}
                          </p>

                          {/* マーカー選択 */}
                          <div style={{marginBottom: '16px'}}>
                            <label style={{...styles.inputLabel, marginBottom: '8px', display: 'block'}}>
                              解析するマーカーを選択（複数可）
                            </label>
                            <div style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: '8px',
                              padding: '12px',
                              background: 'white',
                              borderRadius: '8px',
                              border: '1px solid #e5e7eb',
                              maxHeight: '150px',
                              overflowY: 'auto'
                            }}>
                              {selectedItems.length === 0 ? (
                                <div style={{color: '#9ca3af', fontSize: '13px'}}>
                                  まず上部で検査項目を選択してください
                                </div>
                              ) : (
                                selectedItems.map(item => (
                                  <label key={item} style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    padding: '6px 12px',
                                    background: rocSelectedItems.includes(item) ? '#fae8ff' : '#f9fafb',
                                    border: rocSelectedItems.includes(item) ? '2px solid #a21caf' : '1px solid #d1d5db',
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    transition: 'all 0.15s'
                                  }}>
                                    <input
                                      type="checkbox"
                                      checked={rocSelectedItems.includes(item)}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          setRocSelectedItems([...rocSelectedItems, item]);
                                        } else {
                                          setRocSelectedItems(rocSelectedItems.filter(i => i !== item));
                                        }
                                      }}
                                      style={{display: 'none'}}
                                    />
                                    {rocSelectedItems.includes(item) && <span style={{color: '#a21caf'}}>✓</span>}
                                    {item}
                                  </label>
                                ))
                              )}
                            </div>
                            <div style={{marginTop: '6px', display: 'flex', gap: '8px'}}>
                              <button
                                onClick={() => setRocSelectedItems([...selectedItems])}
                                disabled={selectedItems.length === 0}
                                style={{fontSize: '11px', padding: '4px 8px', background: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                              >
                                全選択
                              </button>
                              <button
                                onClick={() => setRocSelectedItems([])}
                                style={{fontSize: '11px', padding: '4px 8px', background: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                              >
                                全解除
                              </button>
                              <span style={{fontSize: '11px', color: '#6b7280', marginLeft: '8px'}}>
                                {rocSelectedItems.length}項目選択中
                              </span>
                            </div>
                          </div>

                          <button
                            onClick={runRocAnalysis}
                            disabled={!selectedGroup1 || !selectedGroup2 || rocSelectedItems.length === 0 || isCalculatingRoc}
                            style={{
                              ...styles.primaryButton,
                              width: '100%',
                              backgroundColor: '#a21caf',
                              opacity: (!selectedGroup1 || !selectedGroup2 || rocSelectedItems.length === 0) ? 0.5 : 1
                            }}
                          >
                            {isCalculatingRoc ? 'ROC曲線計算中...' : 'ROC曲線解析を実行'}
                          </button>

                          {/* ROC解析結果 */}
                          {rocResults && rocResults.length > 0 && (
                            <div style={{marginTop: '20px'}}>
                              {/* 結果テーブル */}
                              <div style={{overflowX: 'auto', marginBottom: '20px'}}>
                                <table style={{
                                  width: '100%',
                                  borderCollapse: 'collapse',
                                  fontSize: '12px',
                                  background: 'white',
                                  borderRadius: '8px',
                                  overflow: 'hidden'
                                }}>
                                  <thead>
                                    <tr style={{background: '#fdf4ff'}}>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>マーカー</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>AUC</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>95% CI</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>カットオフ</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>感度</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>特異度</th>
                                      <th style={{padding: '10px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>n</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {rocResults.map((r, idx) => (
                                      <tr key={idx} style={{background: idx % 2 === 0 ? 'white' : '#fdf4ff'}}>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', fontWeight: '500'}}>
                                          <span style={{display: 'inline-block', width: '12px', height: '12px', borderRadius: '2px', background: rocColors[idx % rocColors.length], marginRight: '8px'}}></span>
                                          {r.item}
                                        </td>
                                        <td style={{
                                          padding: '8px',
                                          borderBottom: '1px solid #e2e8f0',
                                          textAlign: 'center',
                                          fontWeight: (r.auc ?? 0) >= 0.7 ? 'bold' : 'normal',
                                          color: (r.auc ?? 0) >= 0.9 ? '#059669' : (r.auc ?? 0) >= 0.7 ? '#d97706' : '#6b7280'
                                        }}>
                                          {(r.auc ?? 0).toFixed(3)}
                                        </td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center', fontSize: '11px'}}>
                                          {(r.ci?.lower ?? 0).toFixed(3)} - {(r.ci?.upper ?? 1).toFixed(3)}
                                        </td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>
                                          {r.optimal ? (typeof r.optimal.threshold === 'number' ? r.optimal.threshold.toFixed(2) : '-') : '-'}
                                        </td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>
                                          {r.optimal ? (r.optimal.sensitivity * 100).toFixed(1) + '%' : '-'}
                                        </td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>
                                          {r.optimal ? (r.optimal.specificity * 100).toFixed(1) + '%' : '-'}
                                        </td>
                                        <td style={{padding: '8px', borderBottom: '1px solid #e2e8f0', textAlign: 'center', fontSize: '11px'}}>
                                          {r.positiveGroup}: {r.nPositive}<br/>
                                          {r.negativeGroup}: {r.nNegative}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              {/* ROC曲線グラフ（SVG） */}
                              <div style={{
                                padding: '16px',
                                background: 'white',
                                borderRadius: '8px',
                                border: '1px solid #e5e7eb'
                              }}>
                                <h4 style={{margin: '0 0 12px 0', fontSize: '14px', color: '#374151'}}>
                                  ROC曲線
                                </h4>
                                {(() => {
                                  const svgWidth = 500;
                                  const svgHeight = 500;
                                  const margin = { top: 40, right: 150, bottom: 60, left: 60 };
                                  const chartWidth = svgWidth - margin.left - margin.right;
                                  const chartHeight = svgHeight - margin.top - margin.bottom;

                                  // 学術誌スタイル設定を適用
                                  const currentFont = chartFontOptions[chartFontFamily]?.css || 'Arial, sans-serif';

                                  let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="font-family: ${currentFont};">`;
                                  svgContent += `<rect width="100%" height="100%" fill="white"/>`;

                                  // タイトル
                                  svgContent += `<text x="${svgWidth/2 - 50}" y="25" font-size="14" font-weight="bold">ROC Curve</text>`;

                                  // 軸
                                  svgContent += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#333" stroke-width="1"/>`;
                                  svgContent += `<line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${margin.left + chartWidth}" y2="${margin.top + chartHeight}" stroke="#333" stroke-width="1"/>`;

                                  // グリッド線と目盛り
                                  for (let i = 0; i <= 10; i++) {
                                    const val = i / 10;
                                    const x = margin.left + val * chartWidth;
                                    const y = margin.top + chartHeight - val * chartHeight;

                                    // X軸目盛り
                                    svgContent += `<line x1="${x}" y1="${margin.top + chartHeight}" x2="${x}" y2="${margin.top + chartHeight + 5}" stroke="#333" stroke-width="1"/>`;
                                    if (i % 2 === 0) {
                                      svgContent += `<text x="${x}" y="${margin.top + chartHeight + 18}" text-anchor="middle" font-size="10">${val.toFixed(1)}</text>`;
                                    }
                                    // X軸グリッド
                                    svgContent += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + chartHeight}" stroke="#e5e7eb" stroke-width="1"/>`;

                                    // Y軸目盛り
                                    svgContent += `<line x1="${margin.left - 5}" y1="${y}" x2="${margin.left}" y2="${y}" stroke="#333" stroke-width="1"/>`;
                                    if (i % 2 === 0) {
                                      svgContent += `<text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="10">${val.toFixed(1)}</text>`;
                                    }
                                    // Y軸グリッド
                                    svgContent += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + chartWidth}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
                                  }

                                  // 対角線（参照線）
                                  svgContent += `<line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${margin.left + chartWidth}" y2="${margin.top}" stroke="#999" stroke-width="1" stroke-dasharray="5,5"/>`;

                                  // 軸ラベル
                                  svgContent += `<text x="${margin.left + chartWidth/2}" y="${svgHeight - 15}" text-anchor="middle" font-size="12">1 - Specificity (False Positive Rate)</text>`;
                                  svgContent += `<text x="15" y="${margin.top + chartHeight/2}" text-anchor="middle" font-size="12" transform="rotate(-90, 15, ${margin.top + chartHeight/2})">Sensitivity (True Positive Rate)</text>`;

                                  // 各マーカーのROC曲線を描画
                                  rocResults.forEach((result, idx) => {
                                    const color = rocColors[idx % rocColors.length];
                                    const points = result.rocPoints;

                                    if (points && points.length > 1) {
                                      let pathD = '';
                                      points.forEach((p, i) => {
                                        const x = margin.left + p.fpr * chartWidth;
                                        const y = margin.top + chartHeight - p.tpr * chartHeight;
                                        if (i === 0) {
                                          pathD += `M ${x} ${y}`;
                                        } else {
                                          pathD += ` L ${x} ${y}`;
                                        }
                                      });
                                      svgContent += `<path d="${pathD}" stroke="${color}" stroke-width="2" fill="none"/>`;

                                      // 最適カットオフ点をマーク
                                      if (result.optimal) {
                                        const optX = margin.left + (1 - result.optimal.specificity) * chartWidth;
                                        const optY = margin.top + chartHeight - result.optimal.sensitivity * chartHeight;
                                        svgContent += `<circle cx="${optX}" cy="${optY}" r="5" fill="${color}" stroke="white" stroke-width="2"/>`;
                                      }
                                    }
                                  });

                                  // 凡例
                                  const legendX = margin.left + chartWidth + 10;
                                  let legendY = margin.top + 10;
                                  rocResults.forEach((result, idx) => {
                                    const color = rocColors[idx % rocColors.length];
                                    svgContent += `<rect x="${legendX}" y="${legendY}" width="12" height="12" fill="${color}"/>`;
                                    svgContent += `<text x="${legendX + 18}" y="${legendY + 10}" font-size="10">${result.item}</text>`;
                                    svgContent += `<text x="${legendX + 18}" y="${legendY + 22}" font-size="9" fill="#666">AUC: ${(result.auc ?? 0).toFixed(3)}</text>`;
                                    legendY += 35;
                                  });

                                  svgContent += '</svg>';

                                  return (
                                    <div>
                                      <div
                                        ref={rocChartRef}
                                        style={{display: 'flex', justifyContent: 'center'}}
                                        dangerouslySetInnerHTML={{__html: svgContent}}
                                      />
                                      {/* エクスポートボタン */}
                                      <div style={{display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '16px', flexWrap: 'wrap'}}>
                                        <button
                                          onClick={() => {
                                            const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
                                            const url = URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = url;
                                            a.download = `ROC曲線_${rocResults.length}マーカー.svg`;
                                            a.click();
                                            URL.revokeObjectURL(url);
                                          }}
                                          style={{...styles.addButton, backgroundColor: '#a21caf', padding: '8px 16px', fontSize: '12px'}}
                                        >
                                          🎨 SVG保存
                                        </button>
                                        <button
                                          onClick={() => {
                                            // DPI設定に基づくスケール計算
                                            const scale = chartExportDpi / 96;
                                            const canvas = document.createElement('canvas');
                                            canvas.width = svgWidth * scale;
                                            canvas.height = svgHeight * scale;
                                            const ctx = canvas.getContext('2d');
                                            ctx.scale(scale, scale);
                                            const img = new Image();
                                            const svgBlob = new Blob([svgContent], {type: 'image/svg+xml;charset=utf-8'});
                                            const svgUrl = URL.createObjectURL(svgBlob);
                                            img.onload = () => {
                                              ctx.fillStyle = 'white';
                                              ctx.fillRect(0, 0, svgWidth, svgHeight);
                                              ctx.drawImage(img, 0, 0);
                                              URL.revokeObjectURL(svgUrl);
                                              const pngUrl = canvas.toDataURL('image/png');
                                              const a = document.createElement('a');
                                              a.href = pngUrl;
                                              a.download = `ROC曲線_${rocResults.length}マーカー_${chartExportDpi}dpi.png`;
                                              a.click();
                                            };
                                            img.src = svgUrl;
                                          }}
                                          style={{...styles.addButton, backgroundColor: '#059669', padding: '8px 16px', fontSize: '12px'}}
                                        >
                                          📷 PNG ({chartExportDpi}dpi)
                                        </button>
                                        <button
                                          onClick={() => {
                                            // CSV出力
                                            const headers = ['マーカー', 'AUC', '95%CI下限', '95%CI上限', 'カットオフ', '感度', '特異度', 'Youden Index', '陽性群n', '陰性群n'];
                                            const rows = rocResults.map(r => [
                                              r.item,
                                              (r.auc ?? 0).toFixed(4),
                                              (r.ci?.lower ?? 0).toFixed(4),
                                              (r.ci?.upper ?? 1).toFixed(4),
                                              r.optimal ? (typeof r.optimal.threshold === 'number' ? r.optimal.threshold.toFixed(4) : '') : '',
                                              r.optimal ? (r.optimal.sensitivity ?? 0).toFixed(4) : '',
                                              r.optimal ? (r.optimal.specificity ?? 0).toFixed(4) : '',
                                              r.optimal ? (r.optimal.youdenIndex ?? 0).toFixed(4) : '',
                                              r.nPositive ?? 0,
                                              r.nNegative ?? 0
                                            ]);
                                            const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
                                            const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
                                            const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8' });
                                            const url = URL.createObjectURL(blob);
                                            const a = document.createElement('a');
                                            a.href = url;
                                            a.download = `ROC解析結果_${new Date().toISOString().split('T')[0]}.csv`;
                                            document.body.appendChild(a);
                                            a.click();
                                            document.body.removeChild(a);
                                            URL.revokeObjectURL(url);
                                          }}
                                          style={{...styles.addButton, backgroundColor: '#2563eb', padding: '8px 16px', fontSize: '12px'}}
                                        >
                                          📊 結果CSV
                                        </button>
                                        <button
                                          onClick={exportRocRawData}
                                          disabled={!rocRawData}
                                          style={{...styles.addButton, backgroundColor: '#0891b2', padding: '8px 16px', fontSize: '12px', opacity: rocRawData ? 1 : 0.5}}
                                        >
                                          📥 生データCSV
                                        </button>
                                        <button
                                          onClick={exportRocRScript}
                                          style={{...styles.addButton, backgroundColor: '#7c3aed', padding: '8px 16px', fontSize: '12px'}}
                                        >
                                          📜 Rスクリプト
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })()}
                              </div>

                              {/* AUC判定基準 */}
                              <div style={{marginTop: '12px', padding: '12px', background: '#f9fafb', borderRadius: '8px', fontSize: '11px', color: '#6b7280'}}>
                                <strong>AUC判定基準:</strong>
                                <span style={{marginLeft: '12px', color: '#059669'}}>●0.9以上: 優秀</span>
                                <span style={{marginLeft: '12px', color: '#d97706'}}>●0.7-0.9: 良好</span>
                                <span style={{marginLeft: '12px', color: '#6b7280'}}>●0.5-0.7: 不良</span>
                                <span style={{marginLeft: '12px'}}>●0.5: ランダム</span>
                              </div>
                            </div>
                          )}

                          {rocResults && rocResults.length === 0 && (
                            <div style={{marginTop: '16px', padding: '16px', background: '#fef3c7', borderRadius: '8px', color: '#92400e', fontSize: '13px'}}>
                              選択したマーカーに十分なデータがありません（各群2件以上必要）。
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>

                {/* 相関解析セクション */}
                <div style={{
                  marginTop: '30px',
                  padding: '20px',
                  background: '#fff7ed',
                  borderRadius: '12px',
                  border: '1px solid #fed7aa'
                }}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px'}}>
                    <h3 style={{margin: 0, color: '#c2410c', fontSize: '16px'}}>🔥 相関解析</h3>
                    <button
                      onClick={() => setShowCorrelationAnalysis(!showCorrelationAnalysis)}
                      style={{
                        background: showCorrelationAnalysis ? '#c2410c' : 'white',
                        color: showCorrelationAnalysis ? 'white' : '#c2410c',
                        border: '1px solid #c2410c',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px'
                      }}
                    >
                      {showCorrelationAnalysis ? '閉じる' : '開く'}
                    </button>
                  </div>

                  {showCorrelationAnalysis && (
                    <>
                      <p style={{fontSize: '12px', color: '#6b7280', marginBottom: '16px'}}>
                        選択したマーカー間の相関係数を計算し、ヒートマップで可視化します。
                        {selectedPatientIds.length > 0 && (
                          <span style={{marginLeft: '8px', color: '#c2410c'}}>
                            （{selectedPatientIds.length}名の患者を対象）
                          </span>
                        )}
                      </p>

                      {/* 相関係数の種類選択 */}
                      <div style={{marginBottom: '16px'}}>
                        <label style={{...styles.inputLabel, marginBottom: '8px', display: 'block'}}>
                          相関係数の種類
                        </label>
                        <div style={{display: 'flex', gap: '12px'}}>
                          <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '8px 16px',
                            background: correlationType === 'spearman' ? '#c2410c' : 'white',
                            color: correlationType === 'spearman' ? 'white' : '#374151',
                            border: '1px solid #d1d5db',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            fontSize: '13px'
                          }}>
                            <input
                              type="radio"
                              name="correlationType"
                              checked={correlationType === 'spearman'}
                              onChange={() => setCorrelationType('spearman')}
                              style={{display: 'none'}}
                            />
                            Spearman（順位相関）
                          </label>
                          <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '8px 16px',
                            background: correlationType === 'pearson' ? '#c2410c' : 'white',
                            color: correlationType === 'pearson' ? 'white' : '#374151',
                            border: '1px solid #d1d5db',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            fontSize: '13px'
                          }}>
                            <input
                              type="radio"
                              name="correlationType"
                              checked={correlationType === 'pearson'}
                              onChange={() => setCorrelationType('pearson')}
                              style={{display: 'none'}}
                            />
                            Pearson（積率相関）
                          </label>
                        </div>
                        <p style={{fontSize: '11px', color: '#6b7280', marginTop: '6px'}}>
                          ※ バイオマーカーには正規分布を仮定しないSpearmanを推奨
                        </p>
                      </div>

                      {/* マーカー選択 */}
                      <div style={{marginBottom: '16px'}}>
                        <label style={{...styles.inputLabel, marginBottom: '8px', display: 'block'}}>
                          解析するマーカーを選択（2つ以上）
                        </label>
                        <div style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '8px',
                          padding: '12px',
                          background: 'white',
                          borderRadius: '8px',
                          border: '1px solid #e5e7eb',
                          maxHeight: '150px',
                          overflowY: 'auto'
                        }}>
                          {selectedItems.length === 0 ? (
                            <div style={{color: '#9ca3af', fontSize: '13px'}}>
                              まず上部で検査項目を選択してください
                            </div>
                          ) : (
                            selectedItems.map(item => (
                              <label key={item} style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '6px 12px',
                                background: correlationSelectedItems.includes(item) ? '#ffedd5' : '#f9fafb',
                                border: correlationSelectedItems.includes(item) ? '2px solid #c2410c' : '1px solid #d1d5db',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '12px',
                                transition: 'all 0.15s'
                              }}>
                                <input
                                  type="checkbox"
                                  checked={correlationSelectedItems.includes(item)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setCorrelationSelectedItems([...correlationSelectedItems, item]);
                                    } else {
                                      setCorrelationSelectedItems(correlationSelectedItems.filter(i => i !== item));
                                    }
                                  }}
                                  style={{display: 'none'}}
                                />
                                {correlationSelectedItems.includes(item) && <span style={{color: '#c2410c'}}>✓</span>}
                                {item}
                              </label>
                            ))
                          )}
                        </div>
                        <div style={{marginTop: '6px', display: 'flex', gap: '8px'}}>
                          <button
                            onClick={() => setCorrelationSelectedItems([...selectedItems])}
                            disabled={selectedItems.length === 0}
                            style={{fontSize: '11px', padding: '4px 8px', background: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                          >
                            全選択
                          </button>
                          <button
                            onClick={() => setCorrelationSelectedItems([])}
                            style={{fontSize: '11px', padding: '4px 8px', background: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                          >
                            全解除
                          </button>
                          <span style={{fontSize: '11px', color: '#6b7280', marginLeft: '8px'}}>
                            {correlationSelectedItems.length}項目選択中
                          </span>
                        </div>
                      </div>

                      <button
                        onClick={runCorrelationAnalysis}
                        disabled={correlationSelectedItems.length < 2 || isCalculatingCorrelation}
                        style={{
                          ...styles.primaryButton,
                          width: '100%',
                          backgroundColor: '#c2410c',
                          opacity: correlationSelectedItems.length < 2 ? 0.5 : 1
                        }}
                      >
                        {isCalculatingCorrelation ? '相関計算中...' : '相関解析を実行'}
                      </button>

                      {/* 相関解析結果 */}
                      {correlationResults && (
                        <div style={{marginTop: '20px'}}>
                          {/* ヒートマップ */}
                          <div style={{
                            padding: '16px',
                            background: 'white',
                            borderRadius: '8px',
                            border: '1px solid #e5e7eb'
                          }}>
                            <h4 style={{margin: '0 0 12px 0', fontSize: '14px', color: '#374151'}}>
                              相関ヒートマップ（{correlationResults.type === 'spearman' ? 'Spearman' : 'Pearson'}）
                            </h4>
                            {(() => {
                              const items = correlationResults.items;
                              const n = items.length;
                              const cellSize = Math.min(60, 400 / n);
                              const labelWidth = 100;
                              const margin = { top: 120, right: 80, bottom: 20, left: labelWidth };
                              const svgWidth = margin.left + n * cellSize + margin.right;
                              const svgHeight = margin.top + n * cellSize + margin.bottom;

                              // 学術誌スタイル設定を適用
                              const currentFont = chartFontOptions[chartFontFamily]?.css || 'Arial, sans-serif';

                              let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="font-family: ${currentFont};">`;
                              svgContent += `<rect width="100%" height="100%" fill="white"/>`;

                              // タイトル
                              svgContent += `<text x="${svgWidth/2}" y="20" text-anchor="middle" font-size="14" font-weight="bold">Correlation Heatmap (${correlationResults.type === 'spearman' ? 'Spearman' : 'Pearson'})</text>`;

                              // 上部のラベル（斜め）
                              items.forEach((item, i) => {
                                const x = margin.left + i * cellSize + cellSize / 2;
                                const y = margin.top - 10;
                                svgContent += `<text x="${x}" y="${y}" text-anchor="start" font-size="${Math.min(11, cellSize/4)}" transform="rotate(-45, ${x}, ${y})">${item.length > 15 ? item.substring(0, 15) + '...' : item}</text>`;
                              });

                              // 左側のラベル
                              items.forEach((item, i) => {
                                const x = margin.left - 5;
                                const y = margin.top + i * cellSize + cellSize / 2 + 4;
                                svgContent += `<text x="${x}" y="${y}" text-anchor="end" font-size="${Math.min(11, cellSize/4)}">${item.length > 12 ? item.substring(0, 12) + '...' : item}</text>`;
                              });

                              // ヒートマップセル
                              for (let i = 0; i < n; i++) {
                                for (let j = 0; j < n; j++) {
                                  const x = margin.left + j * cellSize;
                                  const y = margin.top + i * cellSize;
                                  const r = correlationResults.matrix[i][j];
                                  const p = correlationResults.pMatrix[i][j];
                                  const color = getCorrelationColor(r);
                                  const sig = getCorrelationSignificance(p);

                                  svgContent += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${color}" stroke="#e5e7eb" stroke-width="1"/>`;

                                  if (r !== null) {
                                    const textColor = Math.abs(r) > 0.5 ? 'white' : '#374151';
                                    svgContent += `<text x="${x + cellSize/2}" y="${y + cellSize/2 - 2}" text-anchor="middle" font-size="${Math.min(10, cellSize/5)}" fill="${textColor}">${r.toFixed(2)}</text>`;
                                    if (sig) {
                                      svgContent += `<text x="${x + cellSize/2}" y="${y + cellSize/2 + 10}" text-anchor="middle" font-size="${Math.min(9, cellSize/6)}" fill="${textColor}">${sig}</text>`;
                                    }
                                  } else {
                                    svgContent += `<text x="${x + cellSize/2}" y="${y + cellSize/2 + 4}" text-anchor="middle" font-size="${Math.min(10, cellSize/5)}" fill="#9ca3af">N/A</text>`;
                                  }
                                }
                              }

                              // カラースケール凡例
                              const legendX = margin.left + n * cellSize + 20;
                              const legendY = margin.top;
                              const legendHeight = n * cellSize;
                              const legendWidth = 20;

                              // グラデーション定義
                              svgContent += `<defs><linearGradient id="colorScale" x1="0%" y1="100%" x2="0%" y2="0%">`;
                              svgContent += `<stop offset="0%" style="stop-color:rgb(59,130,246);stop-opacity:1"/>`;
                              svgContent += `<stop offset="50%" style="stop-color:rgb(255,255,255);stop-opacity:1"/>`;
                              svgContent += `<stop offset="100%" style="stop-color:rgb(239,68,68);stop-opacity:1"/>`;
                              svgContent += `</linearGradient></defs>`;

                              svgContent += `<rect x="${legendX}" y="${legendY}" width="${legendWidth}" height="${legendHeight}" fill="url(#colorScale)" stroke="#e5e7eb"/>`;
                              svgContent += `<text x="${legendX + legendWidth + 5}" y="${legendY + 10}" font-size="10">+1</text>`;
                              svgContent += `<text x="${legendX + legendWidth + 5}" y="${legendY + legendHeight/2 + 4}" font-size="10">0</text>`;
                              svgContent += `<text x="${legendX + legendWidth + 5}" y="${legendY + legendHeight}" font-size="10">-1</text>`;

                              // 有意水準の凡例
                              svgContent += `<text x="${legendX}" y="${legendY + legendHeight + 20}" font-size="9">*p<0.05</text>`;
                              svgContent += `<text x="${legendX}" y="${legendY + legendHeight + 32}" font-size="9">**p<0.01</text>`;
                              svgContent += `<text x="${legendX}" y="${legendY + legendHeight + 44}" font-size="9">***p<0.001</text>`;

                              svgContent += '</svg>';

                              return (
                                <div>
                                  <div
                                    ref={correlationChartRef}
                                    style={{display: 'flex', justifyContent: 'center', overflowX: 'auto'}}
                                    dangerouslySetInnerHTML={{__html: svgContent}}
                                  />
                                  {/* エクスポートボタン */}
                                  <div style={{display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '16px', flexWrap: 'wrap'}}>
                                    <button
                                      onClick={() => {
                                        const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = `相関ヒートマップ_${correlationResults.type}_${n}項目.svg`;
                                        a.click();
                                        URL.revokeObjectURL(url);
                                      }}
                                      style={{...styles.addButton, backgroundColor: '#c2410c', padding: '8px 16px', fontSize: '12px'}}
                                    >
                                      🎨 SVG保存
                                    </button>
                                    <button
                                      onClick={() => {
                                        // DPI設定に基づくスケール計算
                                        const scale = chartExportDpi / 96;
                                        const canvas = document.createElement('canvas');
                                        canvas.width = svgWidth * scale;
                                        canvas.height = svgHeight * scale;
                                        const ctx = canvas.getContext('2d');
                                        ctx.scale(scale, scale);
                                        const img = new Image();
                                        const svgBlob = new Blob([svgContent], {type: 'image/svg+xml;charset=utf-8'});
                                        const svgUrl = URL.createObjectURL(svgBlob);
                                        img.onload = () => {
                                          ctx.fillStyle = 'white';
                                          ctx.fillRect(0, 0, svgWidth, svgHeight);
                                          ctx.drawImage(img, 0, 0);
                                          URL.revokeObjectURL(svgUrl);
                                          const pngUrl = canvas.toDataURL('image/png');
                                          const a = document.createElement('a');
                                          a.href = pngUrl;
                                          a.download = `相関ヒートマップ_${correlationResults.type}_${n}項目_${chartExportDpi}dpi.png`;
                                          a.click();
                                        };
                                        img.src = svgUrl;
                                      }}
                                      style={{...styles.addButton, backgroundColor: '#059669', padding: '8px 16px', fontSize: '12px'}}
                                    >
                                      📷 PNG ({chartExportDpi}dpi)
                                    </button>
                                    <button
                                      onClick={() => {
                                        // CSV出力（相関行列）
                                        const items = correlationResults.items;
                                        const headers = ['', ...items];
                                        const rows = items.map((item, i) => [
                                          item,
                                          ...items.map((_, j) => {
                                            const r = correlationResults.matrix[i][j];
                                            const p = correlationResults.pMatrix[i][j];
                                            const sig = getCorrelationSignificance(p);
                                            return r !== null ? `${r.toFixed(4)}${sig}` : 'N/A';
                                          })
                                        ]);
                                        const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
                                        const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
                                        const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8' });
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = `相関行列_${correlationResults.type}_${new Date().toISOString().split('T')[0]}.csv`;
                                        document.body.appendChild(a);
                                        a.click();
                                        document.body.removeChild(a);
                                        URL.revokeObjectURL(url);
                                      }}
                                      style={{...styles.addButton, backgroundColor: '#2563eb', padding: '8px 16px', fontSize: '12px'}}
                                    >
                                      📊 相関行列CSV
                                    </button>
                                    <button
                                      onClick={exportCorrelationRawData}
                                      disabled={!correlationRawData}
                                      style={{...styles.addButton, backgroundColor: '#0891b2', padding: '8px 16px', fontSize: '12px', opacity: correlationRawData ? 1 : 0.5}}
                                    >
                                      📥 生データCSV
                                    </button>
                                    <button
                                      onClick={exportCorrelationRScript}
                                      style={{...styles.addButton, backgroundColor: '#7c3aed', padding: '8px 16px', fontSize: '12px'}}
                                    >
                                      📜 Rスクリプト
                                    </button>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>

                          {/* 相関係数テーブル（詳細） */}
                          <div style={{marginTop: '16px'}}>
                            <details>
                              <summary style={{cursor: 'pointer', fontSize: '13px', color: '#374151', marginBottom: '8px'}}>
                                📋 詳細テーブルを表示
                              </summary>
                              <div style={{overflowX: 'auto', marginTop: '8px'}}>
                                <table style={{
                                  width: '100%',
                                  borderCollapse: 'collapse',
                                  fontSize: '11px',
                                  background: 'white'
                                }}>
                                  <thead>
                                    <tr style={{background: '#fff7ed'}}>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>マーカー1</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0', textAlign: 'left'}}>マーカー2</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>r</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>p値</th>
                                      <th style={{padding: '6px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>n</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {correlationResults.items.flatMap((item1, i) =>
                                      correlationResults.items.slice(i + 1).map((item2, jOffset) => {
                                        const j = i + 1 + jOffset;
                                        const r = correlationResults.matrix[i][j];
                                        const p = correlationResults.pMatrix[i][j];
                                        const n = correlationResults.pairCounts[i][j];
                                        return (
                                          <tr key={`${i}-${j}`}>
                                            <td style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>{item1}</td>
                                            <td style={{padding: '6px', borderBottom: '1px solid #e2e8f0'}}>{item2}</td>
                                            <td style={{
                                              padding: '6px',
                                              borderBottom: '1px solid #e2e8f0',
                                              textAlign: 'center',
                                              fontWeight: r !== null && Math.abs(r) >= 0.5 ? 'bold' : 'normal',
                                              color: r !== null ? (r > 0 ? '#dc2626' : '#2563eb') : '#9ca3af'
                                            }}>
                                              {r !== null ? r.toFixed(3) : 'N/A'}
                                            </td>
                                            <td style={{
                                              padding: '6px',
                                              borderBottom: '1px solid #e2e8f0',
                                              textAlign: 'center',
                                              fontWeight: p !== null && p < 0.05 ? 'bold' : 'normal'
                                            }}>
                                              {p !== null ? `${p.toFixed(4)}${getCorrelationSignificance(p)}` : 'N/A'}
                                            </td>
                                            <td style={{padding: '6px', borderBottom: '1px solid #e2e8f0', textAlign: 'center'}}>
                                              {n}
                                            </td>
                                          </tr>
                                        );
                                      })
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            </details>
                          </div>

                          {/* 解釈ガイド */}
                          <div style={{marginTop: '12px', padding: '12px', background: '#f9fafb', borderRadius: '8px', fontSize: '11px', color: '#6b7280'}}>
                            <strong>相関係数の解釈:</strong>
                            <span style={{marginLeft: '12px', color: '#dc2626'}}>●0.7以上: 強い正の相関</span>
                            <span style={{marginLeft: '12px', color: '#f59e0b'}}>●0.4-0.7: 中程度の相関</span>
                            <span style={{marginLeft: '12px', color: '#6b7280'}}>●0.4未満: 弱い相関</span>
                            <span style={{marginLeft: '12px', color: '#2563eb'}}>●負の値: 逆相関</span>
                          </div>
                        </div>
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
                  setSampleSelectionMode('all');
                  setTargetDay('');
                  setSampleDetails(null);
                  setShowGroupComparison(false);
                  setShowCorrelationAnalysis(false);
                  setCorrelationSelectedItems([]);
                  setCorrelationResults(null);
                  setStatSelectedItems([]);
                  setShowRocAnalysis(false);
                  setRocSelectedItems([]);
                  setRocResults(null);
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

                {/* 一括登録フォーム */}
                <div style={{marginBottom: '16px', padding: '12px', background: '#f0f9ff', borderRadius: '6px', border: '1px solid #bae6fd'}}>
                  <div style={{fontSize: '12px', fontWeight: '600', color: '#0369a1', marginBottom: '8px'}}>
                    一括登録（コピー＆ペースト）
                  </div>
                  <textarea
                    value={bulkEmailInput}
                    onChange={(e) => setBulkEmailInput(e.target.value)}
                    placeholder="1行に1メールアドレス、またはカンマ区切りで入力&#10;例:&#10;tanaka@hospital.ac.jp&#10;suzuki@hospital.ac.jp&#10;yamada@hospital.ac.jp"
                    style={{
                      width: '100%',
                      minHeight: '100px',
                      padding: '10px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontFamily: 'monospace',
                      resize: 'vertical',
                      boxSizing: 'border-box'
                    }}
                  />
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px'}}>
                    <span style={{fontSize: '11px', color: '#6b7280'}}>
                      改行・カンマ・セミコロンで区切り可能
                    </span>
                    <button
                      onClick={addBulkEmails}
                      disabled={isBulkAdding || !bulkEmailInput.trim()}
                      style={{
                        backgroundColor: isBulkAdding ? '#9ca3af' : '#0ea5e9',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '8px 16px',
                        fontSize: '13px',
                        fontWeight: '500',
                        cursor: isBulkAdding ? 'wait' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}
                    >
                      {isBulkAdding ? '登録中...' : '一括登録'}
                    </button>
                  </div>
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

      {/* システム管理パネルモーダル */}
      {showSystemAdminPanel && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '700px'}}>
            <h2 style={styles.modalTitle}>🔧 システム管理</h2>
            <p style={{fontSize: '12px', color: '#6b7280', marginBottom: '20px'}}>
              組織の作成・管理を行います。システム管理者のみアクセス可能です。
            </p>

            {/* タブ切り替え */}
            <div style={{display: 'flex', gap: '8px', marginBottom: '20px'}}>
              <button
                onClick={() => setAdminPanelTab('organizations')}
                style={{
                  padding: '8px 16px',
                  background: adminPanelTab === 'organizations' ? '#3b82f6' : '#f1f5f9',
                  color: adminPanelTab === 'organizations' ? 'white' : '#64748b',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: '500'
                }}
              >
                組織管理
              </button>
              <button
                onClick={async () => {
                  setAdminPanelTab('users');
                  // ユーザー一覧を取得
                  try {
                    const usersSnapshot = await getDocs(collection(db, 'users'));
                    const users = usersSnapshot.docs.map(doc => ({
                      id: doc.id,
                      ...doc.data()
                    }));
                    setAllUsers(users);
                  } catch (err) {
                    console.error('ユーザー取得エラー:', err);
                  }
                }}
                style={{
                  padding: '8px 16px',
                  background: adminPanelTab === 'users' ? '#3b82f6' : '#f1f5f9',
                  color: adminPanelTab === 'users' ? 'white' : '#64748b',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: '500'
                }}
              >
                ユーザー一覧
              </button>
            </div>

            {adminPanelTab === 'organizations' && (
              <>
            {/* 新規組織作成 */}
            <div style={{marginBottom: '24px', padding: '16px', background: '#fef3c7', borderRadius: '8px', border: '1px solid #f59e0b'}}>
              <h3 style={{fontSize: '14px', fontWeight: '600', marginBottom: '12px', color: '#92400e'}}>
                新規組織作成
              </h3>
              <div style={{display: 'grid', gap: '12px'}}>
                <div>
                  <label style={{display: 'block', fontSize: '12px', color: '#6b7280', marginBottom: '4px'}}>
                    組織名 <span style={{color: '#dc2626'}}>*</span>
                  </label>
                  <input
                    type="text"
                    value={newOrgName}
                    onChange={(e) => setNewOrgName(e.target.value)}
                    placeholder="例: 〇〇大学病院 小児科"
                    style={{...styles.input, width: '100%'}}
                  />
                </div>
                <div style={{display: 'flex', gap: '12px'}}>
                  <div style={{flex: 1}}>
                    <label style={{display: 'block', fontSize: '12px', color: '#6b7280', marginBottom: '4px'}}>
                      プラン
                    </label>
                    <select
                      value={newOrgTier}
                      onChange={(e) => setNewOrgTier(e.target.value)}
                      style={{...styles.input, width: '100%'}}
                    >
                      <option value="free">無料（医局用）</option>
                      <option value="paid">有料</option>
                    </select>
                  </div>
                  <div style={{flex: 1}}>
                    <label style={{display: 'block', fontSize: '12px', color: '#6b7280', marginBottom: '4px'}}>
                      紐付け施設
                    </label>
                    <select
                      value={newOrgInstitutionId}
                      onChange={(e) => setNewOrgInstitutionId(e.target.value)}
                      style={{...styles.input, width: '100%'}}
                    >
                      <option value="">-- 選択 --</option>
                      {FREE_INSTITUTIONS.map(inst => (
                        <option key={inst.id} value={inst.id}>{inst.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{display: 'block', fontSize: '12px', color: '#6b7280', marginBottom: '4px'}}>
                    オーナーのメールアドレス
                  </label>
                  <input
                    type="email"
                    value={newOrgOwnerEmail}
                    onChange={(e) => setNewOrgOwnerEmail(e.target.value)}
                    placeholder="owner@example.com"
                    style={{...styles.input, width: '100%'}}
                  />
                </div>
                <button
                  onClick={async () => {
                    if (!newOrgName.trim()) {
                      alert('組織名を入力してください');
                      return;
                    }
                    setIsCreatingOrg(true);
                    try {
                      // 組織を作成（institutionIdを含む）
                      const orgRef = await addDoc(collection(db, 'organizations'), {
                        name: newOrgName.trim(),
                        tier: newOrgTier,
                        institutionId: newOrgInstitutionId || null,
                        createdAt: serverTimestamp(),
                        createdBy: user.uid
                      });

                      // オーナーを設定
                      if (newOrgOwnerEmail.trim()) {
                        await addDoc(collection(db, 'organizationMembers'), {
                          orgId: orgRef.id,
                          email: newOrgOwnerEmail.toLowerCase(),
                          uid: null,
                          role: 'owner',
                          joinedAt: serverTimestamp()
                        });
                      }

                      alert(`組織「${newOrgName}」を作成しました`);
                      setNewOrgName('');
                      setNewOrgOwnerEmail('');
                      setNewOrgTier('paid');
                      setNewOrgInstitutionId('');
                    } catch (err) {
                      alert('エラー: ' + err.message);
                    } finally {
                      setIsCreatingOrg(false);
                    }
                  }}
                  disabled={isCreatingOrg || !newOrgName.trim()}
                  style={{
                    ...styles.primaryButton,
                    backgroundColor: isCreatingOrg ? '#9ca3af' : '#f59e0b',
                    cursor: isCreatingOrg ? 'wait' : 'pointer'
                  }}
                >
                  {isCreatingOrg ? '作成中...' : '組織を作成'}
                </button>
              </div>
            </div>

            {/* メンバー一括追加 */}
            <div style={{marginBottom: '24px', padding: '16px', background: '#f0fdf4', borderRadius: '8px', border: '1px solid #22c55e'}}>
              <h3 style={{fontSize: '14px', fontWeight: '600', marginBottom: '12px', color: '#166534'}}>
                メンバー一括追加
              </h3>
              <div style={{marginBottom: '12px'}}>
                <label style={{display: 'block', fontSize: '12px', color: '#6b7280', marginBottom: '4px'}}>
                  対象組織
                </label>
                <select
                  value={selectedOrgForMembers}
                  onChange={(e) => setSelectedOrgForMembers(e.target.value)}
                  style={{...styles.input, width: '100%'}}
                >
                  <option value="">-- 組織を選択 --</option>
                  {organizations.map(org => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                  ))}
                </select>
              </div>
              <div style={{marginBottom: '12px'}}>
                <label style={{display: 'block', fontSize: '12px', color: '#6b7280', marginBottom: '4px'}}>
                  メールアドレス（1行に1つ、またはカンマ区切り）
                </label>
                <textarea
                  value={bulkMemberInput}
                  onChange={(e) => setBulkMemberInput(e.target.value)}
                  placeholder={"user1@example.com\nuser2@example.com\nuser3@example.com"}
                  style={{
                    width: '100%',
                    minHeight: '80px',
                    padding: '10px',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontFamily: 'monospace',
                    resize: 'vertical',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
              <button
                onClick={async () => {
                  if (!selectedOrgForMembers) {
                    alert('組織を選択してください');
                    return;
                  }
                  if (!bulkMemberInput.trim()) {
                    alert('メールアドレスを入力してください');
                    return;
                  }
                  const emails = bulkMemberInput
                    .split(/[\n,;\s]+/)
                    .map(e => e.toLowerCase().trim())
                    .filter(e => e && e.includes('@'));

                  if (emails.length === 0) {
                    alert('有効なメールアドレスが見つかりませんでした');
                    return;
                  }

                  let added = 0;
                  let skipped = 0;
                  for (const email of emails) {
                    try {
                      await addMemberToOrg(selectedOrgForMembers, email, 'member');
                      added++;
                    } catch (err) {
                      skipped++;
                    }
                  }
                  alert(`${added}件追加しました${skipped > 0 ? ` (${skipped}件はスキップ)` : ''}`);
                  setBulkMemberInput('');
                }}
                disabled={!selectedOrgForMembers || !bulkMemberInput.trim()}
                style={{
                  ...styles.primaryButton,
                  backgroundColor: '#22c55e',
                  cursor: (!selectedOrgForMembers || !bulkMemberInput.trim()) ? 'not-allowed' : 'pointer',
                  opacity: (!selectedOrgForMembers || !bulkMemberInput.trim()) ? 0.5 : 1
                }}
              >
                メンバーを追加
              </button>
            </div>

            {/* 所属組織一覧 */}
            <div style={{marginBottom: '24px', padding: '16px', background: '#f8fafc', borderRadius: '8px'}}>
              <h3 style={{fontSize: '14px', fontWeight: '600', marginBottom: '12px', color: '#374151'}}>
                あなたが所属する組織
              </h3>
              {organizations.length === 0 ? (
                <p style={{fontSize: '13px', color: '#6b7280'}}>所属する組織はありません</p>
              ) : (
                <div style={{display: 'grid', gap: '8px'}}>
                  {organizations.map(org => (
                    <div key={org.id} style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 12px',
                      background: 'white',
                      borderRadius: '6px',
                      border: '1px solid #e5e7eb'
                    }}>
                      <div>
                        <span style={{fontWeight: '500', fontSize: '13px'}}>{org.name}</span>
                        <span style={{
                          marginLeft: '8px',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          backgroundColor: org.tier === 'free' ? '#dbeafe' : '#fef3c7',
                          color: org.tier === 'free' ? '#1e40af' : '#92400e'
                        }}>
                          {org.tier === 'free' ? '無料' : '有料'}
                        </span>
                      </div>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        backgroundColor: org.role === 'owner' ? '#fee2e2' : org.role === 'admin' ? '#fef3c7' : '#f3f4f6',
                        color: org.role === 'owner' ? '#dc2626' : org.role === 'admin' ? '#92400e' : '#6b7280'
                      }}>
                        {org.role === 'owner' ? 'オーナー' : org.role === 'admin' ? '管理者' : 'メンバー'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
              </>
            )}

            {/* ユーザー一覧タブ */}
            {adminPanelTab === 'users' && (
              <div style={{padding: '16px', background: '#f8fafc', borderRadius: '8px'}}>
                <h3 style={{fontSize: '14px', fontWeight: '600', marginBottom: '12px', color: '#374151'}}>
                  登録ユーザー一覧 ({allUsers.length}人)
                </h3>
                {allUsers.length === 0 ? (
                  <p style={{fontSize: '13px', color: '#6b7280'}}>ユーザーがいません</p>
                ) : (
                  <div style={{maxHeight: '400px', overflow: 'auto'}}>
                    <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '12px'}}>
                      <thead>
                        <tr style={{background: '#e5e7eb'}}>
                          <th style={{padding: '8px', textAlign: 'left', borderBottom: '1px solid #d1d5db'}}>メール</th>
                          <th style={{padding: '8px', textAlign: 'left', borderBottom: '1px solid #d1d5db'}}>所属施設</th>
                          <th style={{padding: '8px', textAlign: 'left', borderBottom: '1px solid #d1d5db'}}>プラン</th>
                          <th style={{padding: '8px', textAlign: 'left', borderBottom: '1px solid #d1d5db'}}>登録日</th>
                          <th style={{padding: '8px', textAlign: 'center', borderBottom: '1px solid #d1d5db'}}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allUsers.map(u => (
                          <tr key={u.id} style={{background: 'white'}}>
                            <td style={{padding: '8px', borderBottom: '1px solid #e5e7eb'}}>{u.email}</td>
                            <td style={{padding: '8px', borderBottom: '1px solid #e5e7eb'}}>
                              {u.institutionName || u.institution || '-'}
                            </td>
                            <td style={{padding: '8px', borderBottom: '1px solid #e5e7eb'}}>
                              <span style={{
                                padding: '2px 6px',
                                borderRadius: '4px',
                                fontSize: '10px',
                                backgroundColor: u.tier === 'free' ? '#dbeafe' : u.tier === 'external' ? '#fef2f2' : '#f3f4f6',
                                color: u.tier === 'free' ? '#1e40af' : u.tier === 'external' ? '#dc2626' : '#6b7280'
                              }}>
                                {u.tier === 'free' ? '無料' : u.tier === 'external' ? '外部' : '未設定'}
                              </span>
                            </td>
                            <td style={{padding: '8px', borderBottom: '1px solid #e5e7eb'}}>
                              {u.createdAt?.toDate?.()?.toLocaleDateString?.() || '-'}
                            </td>
                            <td style={{padding: '8px', borderBottom: '1px solid #e5e7eb', textAlign: 'center'}}>
                              <button
                                onClick={async () => {
                                  if (!confirm(`ユーザー「${u.email}」を削除しますか？\n※ユーザーのデータは削除されません。`)) return;
                                  try {
                                    await deleteDoc(doc(db, 'users', u.id));
                                    setAllUsers(allUsers.filter(x => x.id !== u.id));
                                    alert('ユーザーを削除しました');
                                  } catch (err) {
                                    alert('削除に失敗しました: ' + err.message);
                                  }
                                }}
                                style={{
                                  padding: '4px 8px',
                                  background: '#fef2f2',
                                  color: '#dc2626',
                                  border: '1px solid #fecaca',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  fontSize: '11px'
                                }}
                              >
                                削除
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div style={styles.modalActions}>
              <button
                onClick={() => setShowSystemAdminPanel(false)}
                style={styles.cancelButton}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Swimmer Plotモーダル */}
      {showSwimmerPlot && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modalContent, maxWidth: '1200px', width: '95%', maxHeight: '95vh', overflow: 'auto' }}>
            <h2 style={styles.modalTitle}>🏊 Swimmer Plot（患者別タイムライン）</h2>

            {/* コントロールパネル */}
            <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <label style={{ fontSize: '13px', marginRight: '8px' }}>ソート順:</label>
                <select
                  value={swimmerSortBy}
                  onChange={(e) => {
                    setSwimmerSortBy(e.target.value);
                    runSwimmerPlot();
                  }}
                  style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid #d1d5db' }}
                >
                  <option value="duration">観察期間（長い順）</option>
                  <option value="onset">発症日順</option>
                  <option value="id">患者ID順</option>
                </select>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', cursor: 'pointer', background: '#dbeafe', padding: '4px 8px', borderRadius: '4px' }}>
                <input
                  type="checkbox"
                  checked={swimmerFilterHasData}
                  onChange={(e) => setSwimmerFilterHasData(e.target.checked)}
                />
                データのある患者のみ
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={swimmerShowTreatments}
                  onChange={(e) => setSwimmerShowTreatments(e.target.checked)}
                />
                治療薬を表示
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={swimmerShowEvents}
                  onChange={(e) => setSwimmerShowEvents(e.target.checked)}
                />
                臨床イベントを表示
              </label>

              <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => {
                    // SVGエクスポート
                    const svgElement = document.getElementById('swimmer-plot-svg');
                    if (!svgElement) return;
                    const svgData = new XMLSerializer().serializeToString(svgElement);
                    const blob = new Blob([svgData], { type: 'image/svg+xml' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'swimmer_plot.svg';
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ padding: '6px 12px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
                >
                  SVG出力
                </button>
                <button
                  onClick={() => {
                    // PNGエクスポート
                    const svgElement = document.getElementById('swimmer-plot-svg');
                    if (!svgElement) return;
                    const svgData = new XMLSerializer().serializeToString(svgElement);
                    const canvas = document.createElement('canvas');
                    const scale = chartExportDpi / 96;
                    canvas.width = svgElement.width.baseVal.value * scale;
                    canvas.height = svgElement.height.baseVal.value * scale;
                    const ctx = canvas.getContext('2d');
                    ctx.scale(scale, scale);
                    const img = new Image();
                    img.onload = () => {
                      ctx.fillStyle = 'white';
                      ctx.fillRect(0, 0, canvas.width, canvas.height);
                      ctx.drawImage(img, 0, 0);
                      canvas.toBlob((blob) => {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `swimmer_plot_${chartExportDpi}dpi.png`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }, 'image/png');
                    };
                    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
                  }}
                  style={{ padding: '6px 12px', background: '#059669', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
                >
                  PNG出力 ({chartExportDpi}DPI)
                </button>
              </div>
            </div>

            {/* Swimmer Plot SVG */}
            {swimmerData && swimmerData.length > 0 ? (
              <div style={{ overflowX: 'auto', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px' }}>
                {(() => {
                  // フィルタリング：データのある患者のみ
                  const filteredData = swimmerFilterHasData
                    ? swimmerData.filter(p => p.treatments.length > 0 || p.events.length > 0 || p.endDay > 30)
                    : swimmerData;

                  if (filteredData.length === 0) {
                    return <div style={{ textAlign: 'center', padding: '40px', color: '#6b7280' }}>フィルタ条件に一致する患者がいません</div>;
                  }

                  // 使用されている治療カテゴリとイベントタイプを先に収集
                  const usedCategoriesForHeight = new Set();
                  const usedEventTypesForHeight = new Set();
                  filteredData.forEach(p => {
                    p.treatments.forEach(t => usedCategoriesForHeight.add(t.category || 'その他'));
                    (p.events || []).forEach(e => {
                      const eventType = e.type || e.eventType || 'その他';
                      if (eventType && eventType !== 'undefined') {
                        usedEventTypesForHeight.add(eventType);
                      }
                    });
                  });

                  // 凡例を下部に配置するためのサイズ計算（両方の凡例のスペースを確保）
                  const treatmentLegendRows = Math.ceil(usedCategoriesForHeight.size / 6);
                  const eventLegendRows = Math.ceil(usedEventTypesForHeight.size / 5);
                  const bottomLegendHeight =
                    (swimmerShowTreatments && usedCategoriesForHeight.size > 0 ? 30 + treatmentLegendRows * 18 : 0) +
                    (swimmerShowEvents && usedEventTypesForHeight.size > 0 ? 30 + eventLegendRows * 18 : 0) + 20;

                  const margin = { top: 40, right: 40, bottom: 50 + bottomLegendHeight, left: 100 };
                  const rowHeight = 32;
                  const width = 1100;
                  const height = margin.top + margin.bottom + filteredData.length * rowHeight;

                  // 最大日数を計算（適切なスケールに調整）
                  const rawMaxDay = Math.max(...filteredData.map(p => p.endDay));
                  // きりの良い日数に切り上げ
                  const maxDay = rawMaxDay <= 30 ? 30 : rawMaxDay <= 60 ? 60 : rawMaxDay <= 90 ? 90 :
                                 rawMaxDay <= 120 ? 120 : rawMaxDay <= 180 ? 180 : rawMaxDay <= 365 ? 365 :
                                 Math.ceil(rawMaxDay / 100) * 100;

                  const xScale = (day) => margin.left + (day / maxDay) * (width - margin.left - margin.right);
                  const yPos = (index) => margin.top + index * rowHeight + rowHeight / 2;

                  // X軸の目盛りを動的に計算
                  const xTicks = maxDay <= 30 ? [0, 7, 14, 21, 30] :
                                 maxDay <= 60 ? [0, 15, 30, 45, 60] :
                                 maxDay <= 90 ? [0, 30, 60, 90] :
                                 maxDay <= 180 ? [0, 30, 60, 90, 120, 150, 180] :
                                 maxDay <= 365 ? [0, 30, 60, 90, 180, 270, 365] :
                                 [0, 100, 200, 300, 400, 500].filter(d => d <= maxDay);

                  // 上で計算済みの変数を参照
                  const usedCategories = usedCategoriesForHeight;
                  const usedEventTypes = usedEventTypesForHeight;

                  // イベントシェイプの定義（SVGシンボル）
                  const eventShapes = {
                    '意識障害': (x, y, color) => <circle cx={x} cy={y} r="6" fill={color} stroke="#fff" strokeWidth="1" />,
                    'てんかん発作': (x, y, color) => <polygon points={`${x},${y-7} ${x+6},${y+4} ${x-6},${y+4}`} fill={color} stroke="#fff" strokeWidth="1" />,
                    '不随意運動': (x, y, color) => <rect x={x-5} y={y-5} width="10" height="10" fill={color} stroke="#fff" strokeWidth="1" transform={`rotate(45 ${x} ${y})`} />,
                    '麻痺': (x, y, color) => <rect x={x-5} y={y-5} width="10" height="10" fill={color} stroke="#fff" strokeWidth="1" />,
                    '発熱': (x, y, color) => <polygon points={`${x},${y-7} ${x+3},${y-2} ${x+7},${y-2} ${x+4},${y+2} ${x+5},${y+7} ${x},${y+4} ${x-5},${y+7} ${x-4},${y+2} ${x-7},${y-2} ${x-3},${y-2}`} fill={color} stroke="#fff" strokeWidth="0.5" />,
                    '人工呼吸器管理': (x, y, color) => <><line x1={x-5} y1={y} x2={x+5} y2={y} stroke={color} strokeWidth="3" /><line x1={x} y1={y-5} x2={x} y2={y+5} stroke={color} strokeWidth="3" /></>,
                    'ICU入室': (x, y, color) => <><circle cx={x} cy={y} r="7" fill="none" stroke={color} strokeWidth="2" /><circle cx={x} cy={y} r="3" fill={color} /></>,
                    'default': (x, y, color) => <circle cx={x} cy={y} r="5" fill={color} stroke="#fff" strokeWidth="1" />
                  };

                  return (
                    <svg id="swimmer-plot-svg" width={width} height={height} style={{ fontFamily: chartFontFamily === 'times' ? '"Times New Roman", serif' : 'Arial, Helvetica, sans-serif' }}>
                      {/* 背景 */}
                      <rect x="0" y="0" width={width} height={height} fill="white" />

                      {/* タイトル */}
                      <text x={width / 2} y="20" textAnchor="middle" fontSize="16" fontWeight="bold" fill="#1f2937">
                        Swimmer Plot - 患者別治療経過タイムライン
                      </text>

                      {/* X軸 */}
                      <line x1={margin.left} y1={height - margin.bottom} x2={width - margin.right} y2={height - margin.bottom} stroke="#374151" strokeWidth="1" />
                      {xTicks.map(day => (
                        <g key={day}>
                          <line x1={xScale(day)} y1={height - margin.bottom} x2={xScale(day)} y2={height - margin.bottom + 5} stroke="#374151" />
                          <text x={xScale(day)} y={height - margin.bottom + 20} textAnchor="middle" fontSize="11" fill="#6b7280">
                            Day {day}
                          </text>
                        </g>
                      ))}
                      <text x={(margin.left + width - margin.right) / 2} y={height - margin.bottom + 40} textAnchor="middle" fontSize="12" fill="#374151">
                        発症からの日数
                      </text>

                      {/* Y軸（患者ID） */}
                      <line x1={margin.left} y1={margin.top} x2={margin.left} y2={height - margin.bottom} stroke="#374151" strokeWidth="1" />

                      {/* グリッド線 */}
                      {xTicks.filter(d => d > 0).map(day => (
                        <line key={`grid-${day}`} x1={xScale(day)} y1={margin.top} x2={xScale(day)} y2={height - margin.bottom} stroke="#e5e7eb" strokeDasharray="4,4" />
                      ))}

                      {/* 各患者のデータ */}
                      {filteredData.map((patient, index) => (
                        <g key={patient.id}>
                          {/* 患者ID */}
                          <text x={margin.left - 10} y={yPos(index) + 4} textAnchor="end" fontSize="11" fill="#374151" fontWeight="500">
                            {patient.displayId}
                          </text>

                          {/* ベースライン（観察期間） */}
                          <line
                            x1={xScale(patient.startDay)}
                            y1={yPos(index)}
                            x2={xScale(patient.endDay)}
                            y2={yPos(index)}
                            stroke="#9ca3af"
                            strokeWidth="4"
                            strokeLinecap="round"
                          />

                          {/* 治療バー */}
                          {swimmerShowTreatments && patient.treatments.map((treatment, tIdx) => {
                            const color = treatmentColorMap[treatment.category] || treatmentColorMap['その他'];
                            const yOffset = (tIdx % 3 - 1) * 5;
                            return (
                              <g key={`${patient.id}-t-${tIdx}`}>
                                <rect
                                  x={xScale(treatment.dayStart)}
                                  y={yPos(index) - 5 + yOffset}
                                  width={Math.max(xScale(treatment.dayEnd) - xScale(treatment.dayStart), 4)}
                                  height="10"
                                  fill={color}
                                  rx="2"
                                  opacity="0.85"
                                >
                                  <title>{treatment.name}: Day {treatment.dayStart} - Day {treatment.dayEnd}{treatment.ongoing ? ' (継続中)' : ''}</title>
                                </rect>
                                {treatment.ongoing && (
                                  <polygon
                                    points={`${xScale(treatment.dayEnd)},${yPos(index) + yOffset} ${xScale(treatment.dayEnd) + 10},${yPos(index) + yOffset} ${xScale(treatment.dayEnd)},${yPos(index) - 5 + yOffset}`}
                                    fill={color}
                                    opacity="0.85"
                                  />
                                )}
                              </g>
                            );
                          })}

                          {/* イベントマーカー（SVGシェイプ） */}
                          {swimmerShowEvents && patient.events.map((event, eIdx) => {
                            const eventStyle = eventSymbolMap[event.type] || eventSymbolMap['default'];
                            const shapeRenderer = eventShapes[event.type] || eventShapes['default'];
                            // イベントが重なる場合、Y方向に少しオフセット
                            const yOffset = (eIdx % 2) * 12 - 6;
                            return (
                              <g key={`${patient.id}-e-${eIdx}`}>
                                <title>{event.type}: Day {event.day}</title>
                                {shapeRenderer(xScale(event.day), yPos(index) + yOffset, eventStyle.color)}
                              </g>
                            );
                          })}
                        </g>
                      ))}

                      {/* 凡例 - 下部に横並び配置 */}
                      {/* 臨床イベント凡例（先に表示） */}
                      {swimmerShowEvents && (
                        <g transform={`translate(${margin.left}, ${height - bottomLegendHeight + 10})`}>
                          <text x="0" y="0" fontSize="11" fontWeight="bold" fill="#1f2937">【臨床イベント】({usedEventTypes.size}種類)</text>
                          {Array.from(usedEventTypes).map((eventType, idx) => {
                            const style = eventSymbolMap[eventType] || eventSymbolMap['default'];
                            const shapeRenderer = eventShapes[eventType] || eventShapes['default'];
                            const col = idx % 5;
                            const row = Math.floor(idx / 5);
                            return (
                              <g key={eventType} transform={`translate(${col * 160}, ${18 + row * 20})`}>
                                <g transform="translate(8, -2)">
                                  {shapeRenderer(0, 0, style.color)}
                                </g>
                                <text x="22" y="2" fontSize="10" fill="#374151">{eventType}</text>
                              </g>
                            );
                          })}
                        </g>
                      )}

                      {/* 治療薬凡例（後に表示） */}
                      {swimmerShowTreatments && usedCategories.size > 0 && (
                        <g transform={`translate(${margin.left}, ${height - bottomLegendHeight + 10 + (swimmerShowEvents && usedEventTypes.size > 0 ? Math.ceil(usedEventTypes.size / 5) * 20 + 35 : 0)})`}>
                          <text x="0" y="0" fontSize="11" fontWeight="bold" fill="#1f2937">【治療薬】</text>
                          {Array.from(usedCategories).map((category, idx) => {
                            const col = idx % 6;
                            const row = Math.floor(idx / 6);
                            return (
                              <g key={category} transform={`translate(${col * 130}, ${18 + row * 18})`}>
                                <rect x="0" y="-7" width="14" height="9" fill={treatmentColorMap[category] || treatmentColorMap['その他']} rx="2" />
                                <text x="18" y="1" fontSize="9" fill="#374151">{category}</text>
                              </g>
                            );
                          })}
                        </g>
                      )}
                    </svg>
                  );
                })()}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px', color: '#6b7280' }}>
                {swimmerData === null ? 'データを読み込み中...' : '表示可能なデータがありません。患者に発症日・治療薬・臨床イベントを登録してください。'}
              </div>
            )}

            {/* Rスクリプト出力 */}
            {swimmerData && swimmerData.length > 0 && (
              <div style={{ marginTop: '16px' }}>
                <button
                  onClick={() => {
                    // Rスクリプト生成
                    let rScript = `# Swimmer Plot R Script
# Generated from Clinical Data Registry

library(ggplot2)
library(dplyr)

# 患者データ
patients <- data.frame(
  patient_id = c(${swimmerData.map(p => `"${p.displayId}"`).join(', ')}),
  start_day = c(${swimmerData.map(p => p.startDay).join(', ')}),
  end_day = c(${swimmerData.map(p => p.endDay).join(', ')}),
  group = c(${swimmerData.map(p => `"${p.group}"`).join(', ')})
)

# 治療データ
treatments <- data.frame(
  patient_id = character(),
  treatment = character(),
  category = character(),
  day_start = numeric(),
  day_end = numeric(),
  ongoing = logical()
)

${swimmerData.filter(p => p.treatments.length > 0).map(p =>
  p.treatments.map(t =>
    `treatments <- rbind(treatments, data.frame(patient_id="${p.displayId}", treatment="${t.name}", category="${t.category}", day_start=${t.dayStart}, day_end=${t.dayEnd}, ongoing=${t.ongoing ? 'TRUE' : 'FALSE'}))`
  ).join('\n')
).join('\n')}

# イベントデータ
events <- data.frame(
  patient_id = character(),
  event_type = character(),
  day = numeric()
)

${swimmerData.filter(p => p.events.length > 0).map(p =>
  p.events.map(e =>
    `events <- rbind(events, data.frame(patient_id="${p.displayId}", event_type="${e.type}", day=${e.day}))`
  ).join('\n')
).join('\n')}

# 患者IDの順序を設定
patients$patient_id <- factor(patients$patient_id, levels = rev(patients$patient_id))

# Swimmer Plot
ggplot() +
  # ベースライン
  geom_segment(data = patients, aes(x = start_day, xend = end_day, y = patient_id, yend = patient_id),
               color = "gray80", linewidth = 2) +
  # 治療バー
  geom_segment(data = treatments, aes(x = day_start, xend = day_end, y = patient_id, yend = patient_id, color = category),
               linewidth = 4, alpha = 0.7) +
  # イベントマーカー
  geom_point(data = events, aes(x = day, y = patient_id, shape = event_type), size = 3) +
  # ラベル
  labs(x = "Days from Onset", y = "Patient", title = "Swimmer Plot", color = "Treatment", shape = "Event") +
  theme_minimal() +
  theme(
    axis.text.y = element_text(size = 9),
    legend.position = "right"
  )

ggsave("swimmer_plot.pdf", width = 12, height = ${Math.max(6, swimmerData.length * 0.4)}, units = "in")
`;
                    const blob = new Blob([rScript], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'swimmer_plot.R';
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ padding: '6px 12px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
                >
                  📊 Rスクリプト出力
                </button>
              </div>
            )}

            <div style={styles.modalActions}>
              <button
                onClick={() => setShowSwimmerPlot(false)}
                style={styles.cancelButton}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* スパゲッティプロットモーダル */}
      {showSpaghettiPlot && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modal, maxWidth: '1200px', width: '95%', maxHeight: '95vh', overflow: 'auto' }}>
            <h2 style={styles.modalTitle}>スパゲッティプロット（個別患者の検査値推移）</h2>

            {/* コントロールパネル */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '16px',
              marginBottom: '20px',
              padding: '16px',
              background: '#f9fafb',
              borderRadius: '8px'
            }}>
              {/* 検査項目選択 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                  検査項目 {spaghettiData?.labItems ? `(${spaghettiData.labItems.length}項目)` : '(読み込み中...)'}
                </label>
                {spaghettiData?.labItems && spaghettiData.labItems.length > 0 ? (
                  <select
                    value={spaghettiSelectedItem}
                    onChange={(e) => setSpaghettiSelectedItem(e.target.value)}
                    style={{
                      ...styles.input,
                      width: '100%',
                      padding: '8px 12px',
                      fontSize: '14px',
                      border: '1px solid #d1d5db',
                      borderRadius: '6px',
                      backgroundColor: '#fff',
                      cursor: 'pointer'
                    }}
                  >
                    {spaghettiData.labItems.map(item => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                ) : (
                  <div style={{ padding: '8px', color: '#6b7280', fontSize: '13px' }}>
                    {spaghettiData === null ? '読み込み中...' : '検査データがありません'}
                  </div>
                )}
              </div>

              {/* 表示オプション */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>表示オプション</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                    <input
                      type="checkbox"
                      checked={spaghettiColorByGroup}
                      onChange={(e) => setSpaghettiColorByGroup(e.target.checked)}
                    />
                    群ごとに色分け
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                    <input
                      type="checkbox"
                      checked={spaghettiShowPoints}
                      onChange={(e) => setSpaghettiShowPoints(e.target.checked)}
                    />
                    データポイントを表示
                  </label>
                </div>
              </div>

              {/* 患者選択 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                  患者選択 ({spaghettiSelectedPatients.length}/{patients.length})
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => setSpaghettiSelectedPatients(patients.map(p => p.id))}
                    style={{ ...styles.addButton, padding: '4px 8px', fontSize: '11px', backgroundColor: '#3b82f6' }}
                  >
                    全選択
                  </button>
                  <button
                    onClick={() => setSpaghettiSelectedPatients([])}
                    style={{ ...styles.addButton, padding: '4px 8px', fontSize: '11px', backgroundColor: '#6b7280' }}
                  >
                    全解除
                  </button>
                </div>
              </div>

              {/* エクスポート */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>エクスポート</label>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => {
                      const svgElement = spaghettiChartRef.current?.querySelector('svg');
                      if (!svgElement) return;
                      const svgData = new XMLSerializer().serializeToString(svgElement);
                      const blob = new Blob([svgData], { type: 'image/svg+xml' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `spaghetti_plot_${spaghettiSelectedItem}_${new Date().toISOString().split('T')[0]}.svg`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    style={{ ...styles.addButton, padding: '4px 8px', fontSize: '11px', backgroundColor: '#059669' }}
                  >
                    SVG
                  </button>
                  <button
                    onClick={() => {
                      const svgElement = spaghettiChartRef.current?.querySelector('svg');
                      if (!svgElement) return;
                      const canvas = document.createElement('canvas');
                      const ctx = canvas.getContext('2d');
                      const svgData = new XMLSerializer().serializeToString(svgElement);
                      const img = new Image();
                      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
                      const url = URL.createObjectURL(svgBlob);
                      img.onload = () => {
                        canvas.width = img.width * 2;
                        canvas.height = img.height * 2;
                        ctx.scale(2, 2);
                        ctx.fillStyle = 'white';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0);
                        canvas.toBlob((blob) => {
                          const a = document.createElement('a');
                          a.href = URL.createObjectURL(blob);
                          a.download = `spaghetti_plot_${spaghettiSelectedItem}_300dpi.png`;
                          a.click();
                        }, 'image/png');
                        URL.revokeObjectURL(url);
                      };
                      img.src = url;
                    }}
                    style={{ ...styles.addButton, padding: '4px 8px', fontSize: '11px', backgroundColor: '#7c3aed' }}
                  >
                    PNG
                  </button>
                </div>
              </div>
            </div>

            {/* 群別凡例 */}
            {spaghettiColorByGroup && spaghettiData?.groups && (
              <div style={{
                display: 'flex',
                gap: '16px',
                flexWrap: 'wrap',
                marginBottom: '16px',
                padding: '12px',
                background: '#f3f4f6',
                borderRadius: '6px'
              }}>
                <span style={{ fontWeight: '600', fontSize: '13px', color: '#374151' }}>【群】</span>
                {spaghettiData.groups.map((group, idx) => (
                  <span key={group} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                    <span style={{
                      width: '20px',
                      height: '3px',
                      backgroundColor: getGroupColor(group, spaghettiData.groups),
                      display: 'inline-block'
                    }}></span>
                    {group}
                  </span>
                ))}
              </div>
            )}

            {/* グラフ表示エリア */}
            <div ref={spaghettiChartRef} style={{ background: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
              {spaghettiData && spaghettiSelectedItem ? (() => {
                // 選択された検査項目のデータをフィルタリング
                const filteredPatients = spaghettiData.patients
                  .filter(p => spaghettiSelectedPatients.includes(p.id))
                  .map(p => ({
                    ...p,
                    dataPoints: p.dataPoints.filter(d => d.item === spaghettiSelectedItem && d.day !== null)
                  }))
                  .filter(p => p.dataPoints.length > 0);

                if (filteredPatients.length === 0) {
                  return <div style={{ textAlign: 'center', padding: '40px', color: '#6b7280' }}>選択した検査項目のデータがありません</div>;
                }

                // スケール計算
                const allDays = filteredPatients.flatMap(p => p.dataPoints.map(d => d.day));
                const allValues = filteredPatients.flatMap(p => p.dataPoints.map(d => d.value));
                const minDay = Math.min(...allDays);
                const maxDay = Math.max(...allDays);
                const minValue = Math.min(...allValues);
                const maxValue = Math.max(...allValues);
                const valueRange = maxValue - minValue || 1;
                const dayRange = maxDay - minDay || 1;

                const margin = { top: 40, right: 120, bottom: 60, left: 80 };
                const width = 900;
                const height = 500;
                const chartWidth = width - margin.left - margin.right;
                const chartHeight = height - margin.top - margin.bottom;

                const xScale = (day) => margin.left + ((day - minDay) / dayRange) * chartWidth;
                const yScale = (value) => height - margin.bottom - ((value - minValue) / valueRange) * chartHeight;

                // Y軸の目盛り
                const yTickCount = 6;
                const yTicks = Array.from({ length: yTickCount }, (_, i) => minValue + (valueRange * i) / (yTickCount - 1));

                // X軸の目盛り
                const xTickCount = Math.min(10, dayRange + 1);
                const xTicks = Array.from({ length: xTickCount }, (_, i) => Math.round(minDay + (dayRange * i) / (xTickCount - 1)));

                // 単位を取得
                const unit = filteredPatients[0]?.dataPoints[0]?.unit || '';

                return (
                  <svg width={width} height={height} style={{ fontFamily: 'Arial, sans-serif' }}>
                    {/* 背景 */}
                    <rect x="0" y="0" width={width} height={height} fill="white" />

                    {/* タイトル */}
                    <text x={width / 2} y="25" textAnchor="middle" fontSize="16" fontWeight="bold" fill="#1f2937">
                      {spaghettiSelectedItem} の経時変化
                    </text>

                    {/* グリッド線 */}
                    {yTicks.map(tick => (
                      <line key={`y-grid-${tick}`} x1={margin.left} y1={yScale(tick)} x2={width - margin.right} y2={yScale(tick)} stroke="#e5e7eb" strokeDasharray="4,4" />
                    ))}
                    {xTicks.map(tick => (
                      <line key={`x-grid-${tick}`} x1={xScale(tick)} y1={margin.top} x2={xScale(tick)} y2={height - margin.bottom} stroke="#e5e7eb" strokeDasharray="4,4" />
                    ))}

                    {/* 軸 */}
                    <line x1={margin.left} y1={height - margin.bottom} x2={width - margin.right} y2={height - margin.bottom} stroke="#374151" strokeWidth="1" />
                    <line x1={margin.left} y1={margin.top} x2={margin.left} y2={height - margin.bottom} stroke="#374151" strokeWidth="1" />

                    {/* X軸ラベル */}
                    {xTicks.map(tick => (
                      <g key={`x-tick-${tick}`}>
                        <line x1={xScale(tick)} y1={height - margin.bottom} x2={xScale(tick)} y2={height - margin.bottom + 5} stroke="#374151" />
                        <text x={xScale(tick)} y={height - margin.bottom + 18} textAnchor="middle" fontSize="11" fill="#6b7280">
                          {tick}
                        </text>
                      </g>
                    ))}
                    <text x={(margin.left + width - margin.right) / 2} y={height - 15} textAnchor="middle" fontSize="12" fill="#374151">
                      発症からの日数
                    </text>

                    {/* Y軸ラベル */}
                    {yTicks.map(tick => (
                      <g key={`y-tick-${tick}`}>
                        <line x1={margin.left - 5} y1={yScale(tick)} x2={margin.left} y2={yScale(tick)} stroke="#374151" />
                        <text x={margin.left - 10} y={yScale(tick) + 4} textAnchor="end" fontSize="11" fill="#6b7280">
                          {tick.toFixed(1)}
                        </text>
                      </g>
                    ))}
                    <text x={25} y={height / 2} textAnchor="middle" fontSize="12" fill="#374151" transform={`rotate(-90, 25, ${height / 2})`}>
                      {spaghettiSelectedItem} {unit ? `(${unit})` : ''}
                    </text>

                    {/* データライン */}
                    {filteredPatients.map((patient, pIdx) => {
                      const sortedPoints = [...patient.dataPoints].sort((a, b) => a.day - b.day);
                      if (sortedPoints.length < 1) return null;

                      const color = spaghettiColorByGroup
                        ? getGroupColor(patient.group, spaghettiData.groups)
                        : `hsl(${(pIdx * 360) / filteredPatients.length}, 70%, 50%)`;

                      const pathD = sortedPoints
                        .map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(d.day)} ${yScale(d.value)}`)
                        .join(' ');

                      return (
                        <g key={patient.id}>
                          <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" opacity="0.7" />
                          {spaghettiShowPoints && sortedPoints.map((d, i) => (
                            <circle key={i} cx={xScale(d.day)} cy={yScale(d.value)} r="3" fill={color} opacity="0.8">
                              <title>{patient.displayId}: Day {d.day}, {d.value} {unit}</title>
                            </circle>
                          ))}
                          {/* 最後のポイントに患者IDラベル */}
                          {sortedPoints.length > 0 && (
                            <text
                              x={xScale(sortedPoints[sortedPoints.length - 1].day) + 5}
                              y={yScale(sortedPoints[sortedPoints.length - 1].value) + 4}
                              fontSize="9"
                              fill={color}
                            >
                              {patient.displayId}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                );
              })() : (
                <div style={{ textAlign: 'center', padding: '40px', color: '#6b7280' }}>
                  {spaghettiData === null ? 'データを読み込み中...' : '検査項目を選択してください'}
                </div>
              )}
            </div>

            {/* Rスクリプト・CSVエクスポート */}
            {spaghettiData && spaghettiSelectedItem && (
              <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => {
                    // CSVエクスポート
                    const filteredPatients = spaghettiData.patients
                      .filter(p => spaghettiSelectedPatients.includes(p.id))
                      .map(p => ({
                        ...p,
                        dataPoints: p.dataPoints.filter(d => d.item === spaghettiSelectedItem && d.day !== null)
                      }))
                      .filter(p => p.dataPoints.length > 0);

                    let csv = 'patient_id,group,day,value,date\n';
                    filteredPatients.forEach(p => {
                      p.dataPoints.forEach(d => {
                        csv += `${p.displayId},${p.group},${d.day},${d.value},${d.date || ''}\n`;
                      });
                    });

                    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
                    const blob = new Blob([bom, csv], { type: 'text/csv;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `spaghetti_data_${spaghettiSelectedItem}_${new Date().toISOString().split('T')[0]}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ ...styles.addButton, backgroundColor: '#059669' }}
                >
                  CSVエクスポート
                </button>
                <button
                  onClick={() => {
                    // Rスクリプト生成
                    const filteredPatients = spaghettiData.patients
                      .filter(p => spaghettiSelectedPatients.includes(p.id))
                      .map(p => ({
                        ...p,
                        dataPoints: p.dataPoints.filter(d => d.item === spaghettiSelectedItem && d.day !== null)
                      }))
                      .filter(p => p.dataPoints.length > 0);

                    const rScript = `# Spaghetti Plot R Script
# Generated from Clinical Data Registry
# Item: ${spaghettiSelectedItem}

library(ggplot2)
library(dplyr)

# データ読み込み（CSVファイルから）
# data <- read.csv("spaghetti_data_${spaghettiSelectedItem}.csv")

# または直接データを定義
data <- data.frame(
  patient_id = c(${filteredPatients.flatMap(p => p.dataPoints.map(() => `"${p.displayId}"`)).join(', ')}),
  group = c(${filteredPatients.flatMap(p => p.dataPoints.map(() => `"${p.group}"`)).join(', ')}),
  day = c(${filteredPatients.flatMap(p => p.dataPoints.map(d => d.day)).join(', ')}),
  value = c(${filteredPatients.flatMap(p => p.dataPoints.map(d => d.value)).join(', ')})
)

# スパゲッティプロット
p <- ggplot(data, aes(x = day, y = value, group = patient_id, color = group)) +
  geom_line(alpha = 0.7) +
  geom_point(alpha = 0.8, size = 2) +
  labs(
    title = "${spaghettiSelectedItem} の経時変化",
    x = "発症からの日数",
    y = "${spaghettiSelectedItem}",
    color = "群"
  ) +
  theme_bw() +
  theme(
    plot.title = element_text(hjust = 0.5, face = "bold"),
    legend.position = "right"
  )

print(p)

# 保存
ggsave("spaghetti_plot_${spaghettiSelectedItem}.pdf", p, width = 10, height = 6)
ggsave("spaghetti_plot_${spaghettiSelectedItem}.png", p, width = 10, height = 6, dpi = 300)
`;

                    const blob = new Blob([rScript], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `spaghetti_plot_${spaghettiSelectedItem}_${new Date().toISOString().split('T')[0]}.R`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ ...styles.addButton, backgroundColor: '#2563eb' }}
                >
                  Rスクリプト
                </button>
              </div>
            )}

            <div style={styles.modalActions}>
              <button
                onClick={() => setShowSpaghettiPlot(false)}
                style={styles.cancelButton}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ヒートマップモーダル */}
      {showHeatmap && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modal, maxWidth: '1400px', width: '95%', maxHeight: '95vh', overflow: 'auto' }}>
            <h2 style={styles.modalTitle}>ヒートマップ（検査値の患者間比較）</h2>

            {/* コントロールパネル */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '16px',
              marginBottom: '20px',
              padding: '16px',
              background: '#f9fafb',
              borderRadius: '8px'
            }}>
              {/* 検査項目選択 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                  検査項目 {heatmapData?.labItems ? `(${heatmapSelectedItems.length}/${heatmapData.labItems.length}選択)` : '(読み込み中...)'}
                </label>
                {heatmapData?.labItems && heatmapData.labItems.length > 0 ? (
                  <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '8px', backgroundColor: '#fff' }}>
                    <div style={{ marginBottom: '8px', display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => setHeatmapSelectedItems(heatmapData.labItems.slice(0, 10))}
                        style={{ ...styles.addButton, padding: '2px 6px', fontSize: '10px', backgroundColor: '#3b82f6' }}
                      >
                        上位10項目
                      </button>
                      <button
                        onClick={() => setHeatmapSelectedItems([])}
                        style={{ ...styles.addButton, padding: '2px 6px', fontSize: '10px', backgroundColor: '#6b7280' }}
                      >
                        全解除
                      </button>
                    </div>
                    {heatmapData.labItems.map(item => (
                      <label key={item} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '2px 0' }}>
                        <input
                          type="checkbox"
                          checked={heatmapSelectedItems.includes(item)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setHeatmapSelectedItems([...heatmapSelectedItems, item]);
                            } else {
                              setHeatmapSelectedItems(heatmapSelectedItems.filter(i => i !== item));
                            }
                          }}
                        />
                        {item}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: '8px', color: '#6b7280', fontSize: '13px' }}>
                    {heatmapData === null ? '読み込み中...' : '検査データがありません'}
                  </div>
                )}
              </div>

              {/* 患者選択 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                  患者選択 {heatmapData?.patients ? `(${heatmapSelectedPatients.length}/${heatmapData.patients.length}名)` : ''}
                </label>
                {heatmapData?.patients && heatmapData.patients.length > 0 ? (
                  <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '8px', backgroundColor: '#fff' }}>
                    <div style={{ marginBottom: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setHeatmapSelectedPatients(heatmapData.patients.map(p => p.id))}
                        style={{ ...styles.addButton, padding: '2px 6px', fontSize: '10px', backgroundColor: '#3b82f6' }}
                      >
                        全選択
                      </button>
                      <button
                        onClick={() => setHeatmapSelectedPatients([])}
                        style={{ ...styles.addButton, padding: '2px 6px', fontSize: '10px', backgroundColor: '#6b7280' }}
                      >
                        全解除
                      </button>
                      {/* 群ごとの選択ボタン */}
                      {heatmapData.groups.map(group => (
                        <button
                          key={group}
                          onClick={() => {
                            const groupPatientIds = heatmapData.patients.filter(p => p.group === group).map(p => p.id);
                            const currentlySelected = heatmapSelectedPatients.filter(id => groupPatientIds.includes(id));
                            if (currentlySelected.length === groupPatientIds.length) {
                              // 全て選択済みなら解除
                              setHeatmapSelectedPatients(heatmapSelectedPatients.filter(id => !groupPatientIds.includes(id)));
                            } else {
                              // そうでなければ追加
                              const newSelection = [...new Set([...heatmapSelectedPatients, ...groupPatientIds])];
                              setHeatmapSelectedPatients(newSelection);
                            }
                          }}
                          style={{
                            ...styles.addButton,
                            padding: '2px 6px',
                            fontSize: '10px',
                            backgroundColor: getGroupColor(group, heatmapData.groups),
                            opacity: heatmapSelectedPatients.filter(id => heatmapData.patients.find(p => p.id === id)?.group === group).length > 0 ? 1 : 0.5
                          }}
                        >
                          {group}
                        </button>
                      ))}
                    </div>
                    {heatmapData.patients
                      .sort((a, b) => {
                        const groupCompare = (a.group || '').localeCompare(b.group || '');
                        if (groupCompare !== 0) return groupCompare;
                        return (a.displayId || '').localeCompare(b.displayId || '');
                      })
                      .map(patient => (
                        <label key={patient.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '2px 0' }}>
                          <input
                            type="checkbox"
                            checked={heatmapSelectedPatients.includes(patient.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setHeatmapSelectedPatients([...heatmapSelectedPatients, patient.id]);
                              } else {
                                setHeatmapSelectedPatients(heatmapSelectedPatients.filter(id => id !== patient.id));
                              }
                            }}
                          />
                          <span style={{
                            width: '8px',
                            height: '8px',
                            backgroundColor: getGroupColor(patient.group, heatmapData.groups),
                            borderRadius: '2px',
                            display: 'inline-block'
                          }}></span>
                          {patient.displayId} ({patient.group})
                        </label>
                      ))}
                  </div>
                ) : null}
              </div>

              {/* 時点選択 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>値の選択</label>
                <select
                  value={heatmapTimepoint}
                  onChange={(e) => setHeatmapTimepoint(e.target.value)}
                  style={{ ...styles.input, width: '100%', padding: '8px', fontSize: '13px' }}
                >
                  <option value="first">最初の値</option>
                  <option value="last">最後の値</option>
                  <option value="peak">ピーク値（最大）</option>
                  <option value="mean">平均値</option>
                </select>
              </div>

              {/* ソート順 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>並び順</label>
                <select
                  value={heatmapSortBy}
                  onChange={(e) => setHeatmapSortBy(e.target.value)}
                  style={{ ...styles.input, width: '100%', padding: '8px', fontSize: '13px' }}
                >
                  <option value="group">群順</option>
                  <option value="id">患者ID順</option>
                </select>
              </div>

              {/* カラースケール */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>カラースケール</label>
                <select
                  value={heatmapColorScale}
                  onChange={(e) => setHeatmapColorScale(e.target.value)}
                  style={{ ...styles.input, width: '100%', padding: '8px', fontSize: '13px' }}
                >
                  <option value="bluered">青→白→赤</option>
                  <option value="viridis">Viridis</option>
                  <option value="grayscale">グレースケール</option>
                </select>
              </div>

              {/* エクスポート */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>エクスポート</label>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => {
                      const svgElement = heatmapChartRef.current?.querySelector('svg');
                      if (!svgElement) return;
                      const svgData = new XMLSerializer().serializeToString(svgElement);
                      const blob = new Blob([svgData], { type: 'image/svg+xml' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `heatmap_${new Date().toISOString().split('T')[0]}.svg`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    style={{ ...styles.addButton, padding: '4px 8px', fontSize: '11px', backgroundColor: '#059669' }}
                  >
                    SVG
                  </button>
                  <button
                    onClick={() => {
                      const svgElement = heatmapChartRef.current?.querySelector('svg');
                      if (!svgElement) return;
                      const canvas = document.createElement('canvas');
                      const ctx = canvas.getContext('2d');
                      const svgData = new XMLSerializer().serializeToString(svgElement);
                      const img = new Image();
                      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
                      const url = URL.createObjectURL(svgBlob);
                      img.onload = () => {
                        const scale = chartExportDpi / 96;
                        canvas.width = img.width * scale;
                        canvas.height = img.height * scale;
                        ctx.scale(scale, scale);
                        ctx.fillStyle = 'white';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0);
                        canvas.toBlob((blob) => {
                          const a = document.createElement('a');
                          a.href = URL.createObjectURL(blob);
                          a.download = `heatmap_${chartExportDpi}dpi.png`;
                          a.click();
                        }, 'image/png');
                        URL.revokeObjectURL(url);
                      };
                      img.src = url;
                    }}
                    style={{ ...styles.addButton, padding: '4px 8px', fontSize: '11px', backgroundColor: '#7c3aed' }}
                  >
                    PNG
                  </button>
                </div>
              </div>
            </div>

            {/* 群別凡例 */}
            {heatmapData?.groups && (
              <div style={{
                display: 'flex',
                gap: '16px',
                flexWrap: 'wrap',
                marginBottom: '16px',
                padding: '12px',
                background: '#f3f4f6',
                borderRadius: '6px'
              }}>
                <span style={{ fontWeight: '600', fontSize: '13px', color: '#374151' }}>【群】</span>
                {heatmapData.groups.map((group, idx) => (
                  <span key={group} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                    <span style={{
                      width: '12px',
                      height: '12px',
                      backgroundColor: getGroupColor(group, heatmapData.groups),
                      display: 'inline-block',
                      borderRadius: '2px'
                    }}></span>
                    {group}
                  </span>
                ))}
              </div>
            )}

            {/* ヒートマップ表示エリア */}
            <div ref={heatmapChartRef} style={{ background: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #e5e7eb', overflowX: 'auto' }}>
              {heatmapData && heatmapSelectedItems.length > 0 && heatmapSelectedPatients.length > 0 ? (() => {
                // 選択された検査項目のデータを取得
                const selectedItems = heatmapSelectedItems;

                // 選択された患者をフィルタしてソート
                const sortedPatients = [...heatmapData.patients]
                  .filter(p => heatmapSelectedPatients.includes(p.id))
                  .sort((a, b) => {
                    if (heatmapSortBy === 'group') {
                      const groupCompare = (a.group || '').localeCompare(b.group || '');
                      if (groupCompare !== 0) return groupCompare;
                      return (a.displayId || '').localeCompare(b.displayId || '');
                    }
                    return (a.displayId || '').localeCompare(b.displayId || '');
                  });

                // 各患者・検査項目の値を計算
                const getDisplayValue = (patient, item) => {
                  const values = patient.itemValues[item];
                  if (!values || values.length === 0) return null;

                  switch (heatmapTimepoint) {
                    case 'first':
                      return values[0].value;
                    case 'last':
                      return values[values.length - 1].value;
                    case 'peak':
                      return Math.max(...values.map(v => v.value));
                    case 'mean':
                      return values.reduce((sum, v) => sum + v.value, 0) / values.length;
                    default:
                      return values[0].value;
                  }
                };

                // 正規化
                const normalizeValue = (value, item) => {
                  if (value === null) return null;
                  const info = heatmapData.itemInfo[item];
                  if (!info || info.max === info.min) return 0.5;
                  return (value - info.min) / (info.max - info.min);
                };

                // サイズ計算
                const cellWidth = 60;
                const cellHeight = 24;
                const labelWidth = 100;
                const headerHeight = 120;
                const colorBarHeight = 20;
                const margin = { top: headerHeight + 20, right: 100, bottom: 60, left: labelWidth + 10 };

                const chartWidth = margin.left + selectedItems.length * cellWidth + margin.right;
                const chartHeight = margin.top + sortedPatients.length * cellHeight + margin.bottom;

                return (
                  <svg width={chartWidth} height={chartHeight} style={{ fontFamily: 'Arial, sans-serif' }}>
                    {/* 背景 */}
                    <rect x="0" y="0" width={chartWidth} height={chartHeight} fill="white" />

                    {/* タイトル */}
                    <text x={chartWidth / 2} y="20" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#1f2937">
                      検査値ヒートマップ（{heatmapTimepoint === 'first' ? '最初の値' : heatmapTimepoint === 'last' ? '最後の値' : heatmapTimepoint === 'peak' ? 'ピーク値' : '平均値'}）
                    </text>

                    {/* カラースケールバー */}
                    <defs>
                      <linearGradient id="heatmapGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor={getHeatmapColor(0, heatmapColorScale)} />
                        <stop offset="50%" stopColor={getHeatmapColor(0.5, heatmapColorScale)} />
                        <stop offset="100%" stopColor={getHeatmapColor(1, heatmapColorScale)} />
                      </linearGradient>
                    </defs>
                    <rect x={chartWidth - 180} y="10" width="120" height={colorBarHeight} fill="url(#heatmapGradient)" stroke="#e5e7eb" />
                    <text x={chartWidth - 185} y="24" textAnchor="end" fontSize="10" fill="#6b7280">低</text>
                    <text x={chartWidth - 55} y="24" textAnchor="start" fontSize="10" fill="#6b7280">高</text>

                    {/* 検査項目ラベル（X軸） */}
                    {selectedItems.map((item, idx) => (
                      <text
                        key={`header-${item}`}
                        x={margin.left + idx * cellWidth + cellWidth / 2}
                        y={margin.top - 10}
                        textAnchor="end"
                        fontSize="10"
                        fill="#374151"
                        transform={`rotate(-45, ${margin.left + idx * cellWidth + cellWidth / 2}, ${margin.top - 10})`}
                      >
                        {item.length > 12 ? item.substring(0, 12) + '...' : item}
                      </text>
                    ))}

                    {/* ヒートマップセル */}
                    {sortedPatients.map((patient, rowIdx) => (
                      <g key={patient.id}>
                        {/* 患者ラベル */}
                        <text
                          x={margin.left - 8}
                          y={margin.top + rowIdx * cellHeight + cellHeight / 2 + 4}
                          textAnchor="end"
                          fontSize="10"
                          fill="#374151"
                        >
                          {patient.displayId}
                        </text>

                        {/* 群カラーインジケータ */}
                        <rect
                          x={margin.left - 6}
                          y={margin.top + rowIdx * cellHeight + 2}
                          width="4"
                          height={cellHeight - 4}
                          fill={getGroupColor(patient.group, heatmapData.groups)}
                        />

                        {/* 各検査項目のセル */}
                        {selectedItems.map((item, colIdx) => {
                          const value = getDisplayValue(patient, item);
                          const normalizedValue = normalizeValue(value, item);
                          const color = getHeatmapColor(normalizedValue, heatmapColorScale);

                          return (
                            <g key={`cell-${patient.id}-${item}`}>
                              <rect
                                x={margin.left + colIdx * cellWidth}
                                y={margin.top + rowIdx * cellHeight}
                                width={cellWidth - 2}
                                height={cellHeight - 2}
                                fill={color}
                                stroke="#fff"
                                strokeWidth="1"
                              >
                                <title>{patient.displayId} - {item}: {value !== null ? value.toFixed(2) : 'N/A'} {heatmapData.itemInfo[item]?.unit || ''}</title>
                              </rect>
                              {/* 値を表示（セルが大きい場合） */}
                              {value !== null && cellWidth >= 50 && (
                                <text
                                  x={margin.left + colIdx * cellWidth + (cellWidth - 2) / 2}
                                  y={margin.top + rowIdx * cellHeight + cellHeight / 2 + 3}
                                  textAnchor="middle"
                                  fontSize="8"
                                  fill={normalizedValue > 0.5 ? '#fff' : '#374151'}
                                >
                                  {value.toFixed(1)}
                                </text>
                              )}
                            </g>
                          );
                        })}
                      </g>
                    ))}

                    {/* 群ごとの区切り線 */}
                    {heatmapSortBy === 'group' && (() => {
                      let prevGroup = null;
                      const lines = [];
                      sortedPatients.forEach((patient, idx) => {
                        if (prevGroup !== null && patient.group !== prevGroup) {
                          lines.push(
                            <line
                              key={`divider-${idx}`}
                              x1={margin.left}
                              y1={margin.top + idx * cellHeight}
                              x2={margin.left + selectedItems.length * cellWidth}
                              y2={margin.top + idx * cellHeight}
                              stroke="#374151"
                              strokeWidth="1.5"
                            />
                          );
                        }
                        prevGroup = patient.group;
                      });
                      return lines;
                    })()}
                  </svg>
                );
              })() : (
                <div style={{ textAlign: 'center', padding: '40px', color: '#6b7280' }}>
                  {heatmapData === null ? 'データを読み込み中...' :
                   heatmapSelectedItems.length === 0 ? '検査項目を選択してください' :
                   heatmapSelectedPatients.length === 0 ? '患者を選択してください' : ''}
                </div>
              )}
            </div>

            {/* CSVエクスポート */}
            {heatmapData && heatmapSelectedItems.length > 0 && heatmapSelectedPatients.length > 0 && (
              <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => {
                    const selectedItems = heatmapSelectedItems;
                    const sortedPatients = [...heatmapData.patients]
                      .filter(p => heatmapSelectedPatients.includes(p.id))
                      .sort((a, b) => {
                        if (heatmapSortBy === 'group') {
                          const groupCompare = (a.group || '').localeCompare(b.group || '');
                          if (groupCompare !== 0) return groupCompare;
                          return (a.displayId || '').localeCompare(b.displayId || '');
                        }
                        return (a.displayId || '').localeCompare(b.displayId || '');
                      });

                    const getDisplayValue = (patient, item) => {
                      const values = patient.itemValues[item];
                      if (!values || values.length === 0) return '';
                      switch (heatmapTimepoint) {
                        case 'first': return values[0].value;
                        case 'last': return values[values.length - 1].value;
                        case 'peak': return Math.max(...values.map(v => v.value));
                        case 'mean': return (values.reduce((sum, v) => sum + v.value, 0) / values.length).toFixed(2);
                        default: return values[0].value;
                      }
                    };

                    let csv = 'patient_id,group,diagnosis,' + selectedItems.join(',') + '\n';
                    sortedPatients.forEach(p => {
                      const values = selectedItems.map(item => getDisplayValue(p, item));
                      csv += `${p.displayId},${p.group},${p.diagnosis || ''},${values.join(',')}\n`;
                    });

                    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
                    const blob = new Blob([bom, csv], { type: 'text/csv;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `heatmap_data_${new Date().toISOString().split('T')[0]}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ ...styles.addButton, backgroundColor: '#059669' }}
                >
                  CSVエクスポート
                </button>
              </div>
            )}

            <div style={styles.modalActions}>
              <button
                onClick={() => setShowHeatmap(false)}
                style={styles.cancelButton}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Kaplan-Meier用データエクスポートモーダル */}
      {showKMExportModal && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modal, maxWidth: '600px', width: '90%' }}>
            <h2 style={styles.modalTitle}>Kaplan-Meier解析用データエクスポート</h2>

            <div style={{ marginBottom: '20px', padding: '12px', background: '#f0f9ff', borderRadius: '8px', fontSize: '13px', color: '#0369a1' }}>
              生存時間解析（Kaplan-Meier曲線）に使用するTidy形式のCSVデータと、Rの解析スクリプトをエクスポートします。
            </div>

            {/* イベントタイプ選択 */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                イベントタイプ（エンドポイント）<span style={{ color: '#ef4444' }}>*</span>
              </label>
              {kmLoadingEventTypes ? (
                <div style={{ padding: '10px', color: '#6b7280', fontSize: '13px' }}>
                  イベントタイプを読み込み中...
                </div>
              ) : kmAvailableEventTypes.length > 0 ? (
                <select
                  value={kmEventType}
                  onChange={(e) => setKmEventType(e.target.value)}
                  style={{ ...styles.input, width: '100%', padding: '10px' }}
                >
                  <option value="">選択してください</option>
                  {kmAvailableEventTypes.map(eventType => (
                    <option key={eventType} value={eventType}>{eventType}</option>
                  ))}
                </select>
              ) : (
                <div style={{ padding: '10px', color: '#ef4444', fontSize: '13px', background: '#fef2f2', borderRadius: '6px' }}>
                  臨床イベントが登録されていません。患者の詳細画面から臨床イベントを追加してください。
                </div>
              )}
              <p style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                登録済みの臨床イベントから選択（{kmAvailableEventTypes.length}種類）
              </p>
            </div>

            {/* 時間単位 */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                時間単位
              </label>
              <div style={{ display: 'flex', gap: '16px' }}>
                {[
                  { value: 'days', label: '日' },
                  { value: 'weeks', label: '週' },
                  { value: 'months', label: '月' }
                ].map(option => (
                  <label key={option.value} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="kmTimeUnit"
                      value={option.value}
                      checked={kmTimeUnit === option.value}
                      onChange={(e) => setKmTimeUnit(e.target.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>

            {/* 打ち切り日 */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                打ち切り日（観察終了日）
              </label>
              <input
                type="date"
                value={kmCensorDate}
                onChange={(e) => setKmCensorDate(e.target.value)}
                style={{ ...styles.input, width: '200px', padding: '8px' }}
              />
              <p style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                イベントが発生していない患者の観察終了日。未指定の場合は今日の日付を使用します。
              </p>
            </div>

            {/* 群選択 */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                比較する群 <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                {[...new Set(patients.map(p => p.group).filter(g => g))].map(group => (
                  <label key={group} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={kmSelectedGroups.includes(group)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setKmSelectedGroups([...kmSelectedGroups, group]);
                        } else {
                          setKmSelectedGroups(kmSelectedGroups.filter(g => g !== group));
                        }
                      }}
                    />
                    {group} ({patients.filter(p => p.group === group).length}名)
                  </label>
                ))}
              </div>
            </div>

            {/* プレビュー情報 */}
            {kmSelectedGroups.length > 0 && (
              <div style={{ marginBottom: '20px', padding: '12px', background: '#f9fafb', borderRadius: '8px' }}>
                <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '8px' }}>エクスポート対象</div>
                <div style={{ fontSize: '12px', color: '#4b5563' }}>
                  対象患者数: {patients.filter(p => kmSelectedGroups.includes(p.group)).length}名
                  （発症日あり: {patients.filter(p => kmSelectedGroups.includes(p.group) && p.onsetDate).length}名）
                </div>
                <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '4px' }}>
                  群: {kmSelectedGroups.join(', ')}
                </div>
              </div>
            )}

            {/* 出力ファイル説明 */}
            <div style={{ marginBottom: '20px', padding: '12px', background: '#fef3c7', borderRadius: '8px', fontSize: '12px' }}>
              <div style={{ fontWeight: '600', marginBottom: '6px', color: '#92400e' }}>出力ファイル</div>
              <ul style={{ margin: 0, paddingLeft: '20px', color: '#78350f' }}>
                <li><strong>CSVデータ</strong>: patient_id, group, time, status (0=打ち切り, 1=イベント)</li>
                <li><strong>Rスクリプト</strong>: survival + survminer パッケージを使用した解析コード</li>
              </ul>
            </div>

            <div style={styles.modalActions}>
              <button
                onClick={() => setShowKMExportModal(false)}
                style={styles.cancelButton}
              >
                キャンセル
              </button>
              <button
                onClick={exportKMData}
                disabled={isExporting || !kmEventType || kmSelectedGroups.length === 0}
                style={{
                  ...styles.addButton,
                  backgroundColor: (!kmEventType || kmSelectedGroups.length === 0) ? '#d1d5db' : '#1e3a5f',
                  opacity: isExporting ? 0.7 : 1
                }}
              >
                {isExporting ? 'エクスポート中...' : 'エクスポート'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Kaplan-Meier曲線モーダル（アプリ内描画） */}
      {showKMChart && (
        <div style={styles.modalOverlay}>
          <div style={{ ...styles.modal, maxWidth: '1000px', width: '95%', maxHeight: '95vh', overflow: 'auto' }}>
            <h2 style={styles.modalTitle}>Kaplan-Meier曲線（生存時間解析）</h2>

            {/* 設定パネル */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '16px',
              marginBottom: '20px',
              padding: '16px',
              background: '#f9fafb',
              borderRadius: '8px'
            }}>
              {/* イベントタイプ */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                  イベント（エンドポイント）
                </label>
                {kmLoadingEventTypes ? (
                  <div style={{ fontSize: '12px', color: '#6b7280' }}>読み込み中...</div>
                ) : (
                  <select
                    value={kmChartEventType}
                    onChange={(e) => { setKmChartEventType(e.target.value); setKmChartData(null); }}
                    style={{ ...styles.input, width: '100%', padding: '8px', fontSize: '13px' }}
                  >
                    <option value="">選択してください</option>
                    {kmAvailableEventTypes.map(et => (
                      <option key={et} value={et}>{et}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* 群1 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                  群1
                </label>
                <select
                  value={kmChartGroup1}
                  onChange={(e) => { setKmChartGroup1(e.target.value); setKmChartData(null); }}
                  style={{ ...styles.input, width: '100%', padding: '8px', fontSize: '13px' }}
                >
                  <option value="">選択してください</option>
                  {[...new Set(patients.map(p => p.group).filter(g => g && g !== kmChartGroup2))].map(g => (
                    <option key={g} value={g}>{g} ({patients.filter(p => p.group === g).length}名)</option>
                  ))}
                </select>
              </div>

              {/* 群2 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>
                  群2
                </label>
                <select
                  value={kmChartGroup2}
                  onChange={(e) => { setKmChartGroup2(e.target.value); setKmChartData(null); }}
                  style={{ ...styles.input, width: '100%', padding: '8px', fontSize: '13px' }}
                >
                  <option value="">選択してください</option>
                  {[...new Set(patients.map(p => p.group).filter(g => g && g !== kmChartGroup1))].map(g => (
                    <option key={g} value={g}>{g} ({patients.filter(p => p.group === g).length}名)</option>
                  ))}
                </select>
              </div>

              {/* 時間単位 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>時間単位</label>
                <select
                  value={kmChartTimeUnit}
                  onChange={(e) => { setKmChartTimeUnit(e.target.value); setKmChartData(null); }}
                  style={{ ...styles.input, width: '100%', padding: '8px', fontSize: '13px' }}
                >
                  <option value="days">日</option>
                  <option value="weeks">週</option>
                  <option value="months">月</option>
                </select>
              </div>

              {/* 打ち切り日 */}
              <div>
                <label style={{ ...styles.inputLabel, marginBottom: '6px', display: 'block' }}>打ち切り日</label>
                <input
                  type="date"
                  value={kmChartCensorDate}
                  onChange={(e) => { setKmChartCensorDate(e.target.value); setKmChartData(null); }}
                  style={{ ...styles.input, width: '100%', padding: '8px', fontSize: '13px' }}
                />
              </div>

              {/* 描画ボタン */}
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button
                  onClick={generateKMChartData}
                  disabled={kmChartLoading || !kmChartEventType || !kmChartGroup1 || !kmChartGroup2}
                  style={{
                    ...styles.addButton,
                    backgroundColor: (!kmChartEventType || !kmChartGroup1 || !kmChartGroup2) ? '#d1d5db' : '#2563eb',
                    width: '100%',
                    justifyContent: 'center',
                    opacity: kmChartLoading ? 0.7 : 1
                  }}
                >
                  {kmChartLoading ? '計算中...' : '曲線を描画'}
                </button>
              </div>
            </div>

            {/* グラフ表示 */}
            <div ref={kmChartRef} style={{ background: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
              {kmChartData ? (() => {
                const { group1, group2, logRank, maxTime, eventType } = kmChartData;
                const timeUnit = kmChartTimeUnit === 'days' ? '日' : kmChartTimeUnit === 'weeks' ? '週' : '月';

                const margin = { top: 50, right: 30, bottom: 80, left: 70 };
                const width = 700;
                const height = 450;
                const chartWidth = width - margin.left - margin.right;
                const chartHeight = height - margin.top - margin.bottom;

                const xMax = Math.ceil(maxTime * 1.1);
                const xScale = (t) => margin.left + (t / xMax) * chartWidth;
                const yScale = (s) => margin.top + (1 - s) * chartHeight;

                // 階段状のパスを生成
                const generateStepPath = (curve) => {
                  let path = `M ${xScale(0)} ${yScale(1)}`;
                  let lastY = yScale(1);

                  curve.forEach((point, i) => {
                    if (i === 0) return;
                    const x = xScale(point.time);
                    const y = yScale(point.survival);
                    // 水平線を引いてから垂直線
                    path += ` L ${x} ${lastY} L ${x} ${y}`;
                    lastY = y;
                  });

                  // 最後まで延長
                  path += ` L ${xScale(xMax)} ${lastY}`;
                  return path;
                };

                const path1 = generateStepPath(group1.curve);
                const path2 = generateStepPath(group2.curve);

                // Y軸目盛り
                const yTicks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
                // X軸目盛り
                const xTickCount = 6;
                const xTicks = Array.from({ length: xTickCount }, (_, i) => Math.round((xMax * i) / (xTickCount - 1)));

                return (
                  <svg width={width} height={height} style={{ fontFamily: 'Arial, sans-serif' }}>
                    <rect x="0" y="0" width={width} height={height} fill="white" />

                    {/* タイトル */}
                    <text x={width / 2} y="25" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#1f2937">
                      Kaplan-Meier Curve: {eventType}
                    </text>

                    {/* グリッド */}
                    {yTicks.map(tick => (
                      <line key={`y-grid-${tick}`} x1={margin.left} y1={yScale(tick)} x2={width - margin.right} y2={yScale(tick)} stroke="#e5e7eb" strokeDasharray="2,2" />
                    ))}

                    {/* 軸 */}
                    <line x1={margin.left} y1={yScale(0)} x2={width - margin.right} y2={yScale(0)} stroke="#374151" />
                    <line x1={margin.left} y1={yScale(0)} x2={margin.left} y2={yScale(1)} stroke="#374151" />

                    {/* X軸ラベル */}
                    {xTicks.map(tick => (
                      <g key={`x-tick-${tick}`}>
                        <line x1={xScale(tick)} y1={yScale(0)} x2={xScale(tick)} y2={yScale(0) + 5} stroke="#374151" />
                        <text x={xScale(tick)} y={yScale(0) + 18} textAnchor="middle" fontSize="11" fill="#6b7280">{tick}</text>
                      </g>
                    ))}
                    <text x={(margin.left + width - margin.right) / 2} y={height - 45} textAnchor="middle" fontSize="12" fill="#374151">
                      Time ({timeUnit})
                    </text>

                    {/* Y軸ラベル */}
                    {yTicks.map(tick => (
                      <g key={`y-tick-${tick}`}>
                        <line x1={margin.left - 5} y1={yScale(tick)} x2={margin.left} y2={yScale(tick)} stroke="#374151" />
                        <text x={margin.left - 10} y={yScale(tick) + 4} textAnchor="end" fontSize="11" fill="#6b7280">{(tick * 100).toFixed(0)}%</text>
                      </g>
                    ))}
                    <text x={20} y={height / 2} textAnchor="middle" fontSize="12" fill="#374151" transform={`rotate(-90, 20, ${height / 2})`}>
                      Event-free Probability
                    </text>

                    {/* 曲線 */}
                    <path d={path1} fill="none" stroke="#E64B35" strokeWidth="2" />
                    <path d={path2} fill="none" stroke="#4DBBD5" strokeWidth="2" />

                    {/* 打ち切りマーク */}
                    {group1.curve.filter(p => p.censored).map((p, i) => (
                      <line key={`c1-${i}`} x1={xScale(p.time)} y1={yScale(p.survival) - 5} x2={xScale(p.time)} y2={yScale(p.survival) + 5} stroke="#E64B35" strokeWidth="1.5" />
                    ))}
                    {group2.curve.filter(p => p.censored).map((p, i) => (
                      <line key={`c2-${i}`} x1={xScale(p.time)} y1={yScale(p.survival) - 5} x2={xScale(p.time)} y2={yScale(p.survival) + 5} stroke="#4DBBD5" strokeWidth="1.5" />
                    ))}

                    {/* 凡例 */}
                    <rect x={width - 200} y="45" width="180" height="55" fill="white" stroke="#e5e7eb" rx="4" />
                    <line x1={width - 190} y1="62" x2={width - 160} y2="62" stroke="#E64B35" strokeWidth="2" />
                    <text x={width - 155} y="66" fontSize="11" fill="#374151">{group1.name} (n={group1.data.length})</text>
                    <line x1={width - 190} y1="82" x2={width - 160} y2="82" stroke="#4DBBD5" strokeWidth="2" />
                    <text x={width - 155} y="86" fontSize="11" fill="#374151">{group2.name} (n={group2.data.length})</text>

                    {/* p値 */}
                    {logRank.pValue !== null && (
                      <text x={width - 110} y={height - 55} textAnchor="middle" fontSize="11" fill="#374151">
                        Log-rank p {logRank.pValue < 0.001 ? '< 0.001' : `= ${logRank.pValue.toFixed(3)}`}
                      </text>
                    )}

                    {/* リスクテーブル */}
                    <text x={margin.left} y={height - 25} fontSize="10" fill="#374151" fontWeight="bold">At risk:</text>
                    <text x={margin.left} y={height - 12} fontSize="10" fill="#E64B35">{group1.name}: {group1.data.length}</text>
                    <text x={margin.left + 150} y={height - 12} fontSize="10" fill="#4DBBD5">{group2.name}: {group2.data.length}</text>
                  </svg>
                );
              })() : (
                <div style={{ textAlign: 'center', padding: '60px', color: '#6b7280' }}>
                  イベントタイプと2つの群を選択して「曲線を描画」をクリックしてください
                </div>
              )}
            </div>

            {/* エクスポートボタン */}
            {kmChartData && (
              <div style={{ marginTop: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => {
                    const svgElement = kmChartRef.current?.querySelector('svg');
                    if (!svgElement) return;
                    const svgData = new XMLSerializer().serializeToString(svgElement);
                    const blob = new Blob([svgData], { type: 'image/svg+xml' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `km_curve_${kmChartData.eventType}_${new Date().toISOString().split('T')[0]}.svg`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ ...styles.addButton, backgroundColor: '#059669' }}
                >
                  SVGエクスポート
                </button>
                <button
                  onClick={() => {
                    const svgElement = kmChartRef.current?.querySelector('svg');
                    if (!svgElement) return;
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const svgData = new XMLSerializer().serializeToString(svgElement);
                    const img = new Image();
                    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
                    const url = URL.createObjectURL(svgBlob);
                    img.onload = () => {
                      const scale = 300 / 96;
                      canvas.width = img.width * scale;
                      canvas.height = img.height * scale;
                      ctx.scale(scale, scale);
                      ctx.fillStyle = 'white';
                      ctx.fillRect(0, 0, canvas.width, canvas.height);
                      ctx.drawImage(img, 0, 0);
                      canvas.toBlob((blob) => {
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = `km_curve_${kmChartData.eventType}_300dpi.png`;
                        a.click();
                      }, 'image/png');
                      URL.revokeObjectURL(url);
                    };
                    img.src = url;
                  }}
                  style={{ ...styles.addButton, backgroundColor: '#7c3aed' }}
                >
                  PNG (300dpi)
                </button>
              </div>
            )}

            <div style={styles.modalActions}>
              <button onClick={() => setShowKMChart(false)} style={styles.cancelButton}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* フッター */}
      <footer style={{
        marginTop: '40px',
        paddingTop: '20px',
        borderTop: '1px solid #e5e7eb',
        textAlign: 'center',
        fontSize: '13px',
        color: '#6b7280'
      }}>
        <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={{color: '#2563eb', textDecoration: 'none', marginRight: '16px'}}>
          利用規約
        </a>
        <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{color: '#2563eb', textDecoration: 'none', marginRight: '16px'}}>
          プライバシーポリシー
        </a>
        <a href="/manual.html" target="_blank" rel="noopener noreferrer" style={{color: '#2563eb', textDecoration: 'none'}}>
          操作マニュアル
        </a>
      </footer>
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
  const [parsedExcelTreatments, setParsedExcelTreatments] = useState([]);
  const [parsedExcelEvents, setParsedExcelEvents] = useState([]);
  const [isMultiSheetExcel, setIsMultiSheetExcel] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [selectedLabIndices, setSelectedLabIndices] = useState([]);
  const [selectedTreatmentIndices, setSelectedTreatmentIndices] = useState([]);
  const [selectedEventIndices, setSelectedEventIndices] = useState([]);
  const [isDraggingExcel, setIsDraggingExcel] = useState(false);

  // 既存検査データ編集用state
  const [editingLabId, setEditingLabId] = useState(null);
  const [editLabItem, setEditLabItem] = useState({ item: '', value: '', unit: '' });

  // サマリー解析用state
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [summaryImage, setSummaryImage] = useState(null);
  const [summaryProcessing, setSummaryProcessing] = useState(false);
  const [summaryResult, setSummaryResult] = useState(null);
  const [summaryError, setSummaryError] = useState('');

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
    // 消化器・一般症状
    '嘔吐': { inputType: 'severity', label: '重症度' },
    '腹痛': { inputType: 'severity', label: '重症度' },
    '下痢': { inputType: 'severity', label: '重症度' },
    '食欲不振': { inputType: 'severity', label: '重症度' },
    // 脱水・代謝関連
    '口渇': { inputType: 'severity', label: '重症度' },
    '多尿': { inputType: 'severity', label: '重症度' },
    '脱水': { inputType: 'severity', label: '重症度' },
    '体重減少': { inputType: 'severity', label: '重症度' },
    // 呼吸器関連
    '頻呼吸': { inputType: 'severity', label: '重症度' },
    '呼吸困難': { inputType: 'severity', label: '重症度' },
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

  // 経時データオーバーレイ用state
  const [showTimeSeriesOverlay, setShowTimeSeriesOverlay] = useState(false);
  const [selectedLabItemsForChart, setSelectedLabItemsForChart] = useState([]);
  const [showTreatmentsOnChart, setShowTreatmentsOnChart] = useState(false);
  const [selectedTreatmentsForChart, setSelectedTreatmentsForChart] = useState([]);
  const [showEventsOnChart, setShowEventsOnChart] = useState(false);
  const [selectedEventsForChart, setSelectedEventsForChart] = useState([]);
  const [timelinePosition, setTimelinePosition] = useState('below'); // 'above' or 'below'
  const [timelineDisplayMode, setTimelineDisplayMode] = useState('separate'); // 'separate' or 'overlay'
  const [useDualAxis, setUseDualAxis] = useState(false); // 二軸表示
  const [secondaryAxisItems, setSecondaryAxisItems] = useState([]); // 右軸に表示する項目
  const overlayChartRef = useRef(null);

  // グラフ表示オプション
  const [chartLabelStyle, setChartLabelStyle] = useState('japanese'); // 'japanese', 'english', 'abbreviation'
  const [chartColorStyle, setChartColorStyle] = useState('color'); // 'color', 'monochrome'

  // ラベル変換マッピング
  const labelTranslations = {
    // 臨床症状
    '意識障害': { english: 'Consciousness Disturbance', abbreviation: 'Consc.' },
    'てんかん発作': { english: 'Epileptic Seizure', abbreviation: 'Sz' },
    '不随意運動': { english: 'Involuntary Movement', abbreviation: 'Invol.Mov.' },
    '麻痺': { english: 'Paralysis', abbreviation: 'Paralysis' },
    '感覚障害': { english: 'Sensory Disturbance', abbreviation: 'Sens.' },
    '失語': { english: 'Aphasia', abbreviation: 'Aphasia' },
    '認知機能障害': { english: 'Cognitive Impairment', abbreviation: 'Cogn.' },
    '精神症状': { english: 'Psychiatric Symptoms', abbreviation: 'Psych.' },
    '発熱': { english: 'Fever', abbreviation: 'Fever' },
    '頭痛': { english: 'Headache', abbreviation: 'HA' },
    '髄膜刺激症状': { english: 'Meningeal Signs', abbreviation: 'Mening.' },
    '人工呼吸器管理': { english: 'Mechanical Ventilation', abbreviation: 'MV' },
    'ICU入室': { english: 'ICU Admission', abbreviation: 'ICU' },
    '嘔吐': { english: 'Vomiting', abbreviation: 'Vomit' },
    '腹痛': { english: 'Abdominal Pain', abbreviation: 'Abd.Pain' },
    '下痢': { english: 'Diarrhea', abbreviation: 'Diarrhea' },
    '口渇': { english: 'Thirst', abbreviation: 'Thirst' },
    '多尿': { english: 'Polyuria', abbreviation: 'Polyuria' },
    '脱水': { english: 'Dehydration', abbreviation: 'Dehydr.' },
    '頻呼吸': { english: 'Tachypnea', abbreviation: 'Tachypnea' },
    '呼吸困難': { english: 'Dyspnea', abbreviation: 'Dyspnea' },
    // 治療薬カテゴリ
    '抗てんかん薬': { english: 'Antiepileptics', abbreviation: 'AED' },
    'ステロイド': { english: 'Steroids', abbreviation: 'Steroid' },
    '免疫グロブリン': { english: 'Immunoglobulin', abbreviation: 'IVIG' },
    '血漿交換': { english: 'Plasma Exchange', abbreviation: 'PE' },
    '免疫抑制剤': { english: 'Immunosuppressants', abbreviation: 'Immunosup.' },
    '抗ウイルス薬': { english: 'Antivirals', abbreviation: 'Antiviral' },
    '抗菌薬': { english: 'Antibiotics', abbreviation: 'Abx' },
    '抗浮腫薬': { english: 'Anti-edema', abbreviation: 'Anti-edema' },
  };

  // ラベル変換関数
  const translateLabel = (label) => {
    if (chartLabelStyle === 'japanese') return label;
    const translation = labelTranslations[label];
    if (translation) {
      return chartLabelStyle === 'english' ? translation.english : translation.abbreviation;
    }
    return label; // 翻訳がない場合は元のラベルを返す
  };

  // 白黒カラーマッピング（治療薬カテゴリ用）
  const monochromeColors = {
    '抗てんかん薬': '#1f2937',
    'ステロイド': '#374151',
    '免疫グロブリン': '#4b5563',
    '血漿交換': '#6b7280',
    '免疫抑制剤': '#9ca3af',
    '抗ウイルス薬': '#d1d5db',
    '抗菌薬': '#1f2937',
    '抗浮腫薬': '#374151',
    'その他': '#6b7280'
  };

  // 白黒パターン（臨床イベント用）- 異なるグレースケール
  const monochromeEventColors = {
    '意識障害': '#111827',
    'てんかん発作': '#1f2937',
    '不随意運動': '#374151',
    '麻痺': '#4b5563',
    '感覚障害': '#6b7280',
    '失語': '#9ca3af',
    '認知機能障害': '#d1d5db',
    '精神症状': '#111827',
    '発熱': '#374151',
    '頭痛': '#6b7280',
    '髄膜刺激症状': '#9ca3af',
    '人工呼吸器管理': '#1f2937',
    'ICU入室': '#4b5563'
  };

  // カラー取得関数（カテゴリ用）
  const getCategoryColor = (category, defaultColorMap) => {
    if (chartColorStyle === 'monochrome') {
      return monochromeColors[category] || '#6b7280';
    }
    return defaultColorMap[category] || '#6b7280';
  };

  // カラー取得関数（イベント用）
  const getEventColor = (eventType, defaultColorMap) => {
    if (chartColorStyle === 'monochrome') {
      return monochromeEventColors[eventType] || '#6b7280';
    }
    return defaultColorMap[eventType] || '#6b7280';
  };

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

      // マルチシート形式かどうか判定（検査データ、治療データ、臨床イベントシートがあるか）
      const hasLabSheet = workbook.SheetNames.some(n => n.includes('検査'));
      const hasTreatmentSheet = workbook.SheetNames.some(n => n.includes('治療'));
      const hasEventSheet = workbook.SheetNames.some(n => n.includes('臨床') || n.includes('イベント'));

      if (hasLabSheet && (hasTreatmentSheet || hasEventSheet)) {
        // マルチシート形式：全シートを自動解析
        setIsMultiSheetExcel(true);
        parseAllExcelSheets(workbook);
        setSelectedSheet('全シート');
      } else {
        // 従来形式：最初のシートのみ
        setIsMultiSheetExcel(false);
        setSelectedSheet(workbook.SheetNames[0]);
        parseExcelSheet(workbook, workbook.SheetNames[0]);
        setParsedExcelTreatments([]);
        setParsedExcelEvents([]);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // マルチシートExcelの全シート解析
  const parseAllExcelSheets = (workbook) => {
    // 検査データシートを解析
    const labSheetName = workbook.SheetNames.find(n => n.includes('検査'));
    if (labSheetName) {
      parseExcelSheet(workbook, labSheetName);
    } else {
      setParsedExcelData([]);
    }

    // 治療データシートを解析
    const treatmentSheetName = workbook.SheetNames.find(n => n.includes('治療'));
    if (treatmentSheetName) {
      parseTreatmentSheet(workbook, treatmentSheetName);
    } else {
      setParsedExcelTreatments([]);
    }

    // 臨床イベントシートを解析
    const eventSheetName = workbook.SheetNames.find(n => n.includes('臨床') || n.includes('イベント'));
    if (eventSheetName) {
      parseEventSheet(workbook, eventSheetName);
    } else {
      setParsedExcelEvents([]);
    }
  };

  // 治療データシートの解析
  const parseTreatmentSheet = (workbook, sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (jsonData.length < 2) {
      setParsedExcelTreatments([]);
      return;
    }

    const header = jsonData[0];
    const treatments = [];

    // ヘッダーから列インデックスを特定
    const colIndex = {
      startDate: header.findIndex(h => h && h.toString().includes('開始')),
      endDate: header.findIndex(h => h && h.toString().includes('終了')),
      category: header.findIndex(h => h && h.toString().includes('カテゴリ')),
      medicationName: header.findIndex(h => h && (h.toString().includes('薬剤') || h.toString().includes('薬品'))),
      dosage: header.findIndex(h => h && h.toString().includes('用量')),
      dosageUnit: header.findIndex(h => h && h.toString().includes('単位'))
    };

    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row || row.length === 0) continue;

      const formatDate = (val) => {
        if (!val) return '';
        if (typeof val === 'number') {
          const date = XLSX.SSF.parse_date_code(val);
          return `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
        }
        return val.toString().replace(/\//g, '-');
      };

      const treatment = {
        startDate: formatDate(row[colIndex.startDate]),
        endDate: formatDate(row[colIndex.endDate]),
        category: colIndex.category >= 0 ? (row[colIndex.category] || 'その他') : 'その他',
        medicationName: colIndex.medicationName >= 0 ? row[colIndex.medicationName] : '',
        dosage: colIndex.dosage >= 0 ? row[colIndex.dosage] : '',
        dosageUnit: colIndex.dosageUnit >= 0 ? row[colIndex.dosageUnit] : ''
      };

      if (treatment.medicationName && treatment.startDate) {
        treatments.push(treatment);
      }
    }

    console.log('Parsed treatments:', treatments);
    setParsedExcelTreatments(treatments);
    setSelectedTreatmentIndices(treatments.map((_, i) => i));
  };

  // 臨床イベントシートの解析
  const parseEventSheet = (workbook, sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (jsonData.length < 2) {
      setParsedExcelEvents([]);
      return;
    }

    const header = jsonData[0];
    const events = [];

    // ヘッダーから列インデックスを特定
    const colIndex = {
      date: header.findIndex(h => h && h.toString().includes('日付')),
      eventType: header.findIndex(h => h && (h.toString().includes('イベント') || h.toString().includes('タイプ') || h.toString().includes('種類'))),
      note: header.findIndex(h => h && (h.toString().includes('詳細') || h.toString().includes('備考') || h.toString().includes('メモ')))
    };

    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row || row.length === 0) continue;

      const formatDate = (val) => {
        if (!val) return '';
        if (typeof val === 'number') {
          const date = XLSX.SSF.parse_date_code(val);
          return `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
        }
        return val.toString().replace(/\//g, '-');
      };

      const event = {
        startDate: formatDate(row[colIndex.date]),
        eventType: colIndex.eventType >= 0 ? row[colIndex.eventType] : '',
        note: colIndex.note >= 0 ? (row[colIndex.note] || '') : ''
      };

      if (event.eventType && event.startDate) {
        events.push(event);
      }
    }

    console.log('Parsed events:', events);
    setParsedExcelEvents(events);
    setSelectedEventIndices(events.map((_, i) => i));
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
    setSelectedLabIndices(result.map((_, i) => i));
  };

  const handleSheetChange = (sheetName) => {
    setSelectedSheet(sheetName);
    if (excelData) {
      parseExcelSheet(excelData, sheetName);
    }
  };

  const importExcelData = async () => {
    const hasSelectedLab = selectedLabIndices.length > 0;
    const hasSelectedTreatments = selectedTreatmentIndices.length > 0;
    const hasSelectedEvents = selectedEventIndices.length > 0;

    if (!hasSelectedLab && !hasSelectedTreatments && !hasSelectedEvents) {
      alert('インポートする項目を選択してください');
      return;
    }

    setIsImporting(true);

    try {
      let labCount = 0, treatmentCount = 0, eventCount = 0;

      // 選択された検査データをインポート
      for (const idx of selectedLabIndices) {
        const dayData = parsedExcelData[idx];
        if (!dayData || dayData.data.length === 0) continue;

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
        labCount++;
      }

      // 選択された治療データをインポート
      for (const idx of selectedTreatmentIndices) {
        const t = parsedExcelTreatments[idx];
        if (!t) continue;

        await addDoc(
          collection(db, 'users', user.uid, 'patients', patient.id, 'treatments'),
          {
            category: t.category || 'その他',
            medicationName: t.medicationName,
            dosage: t.dosage ? String(t.dosage) : '',
            dosageUnit: t.dosageUnit || '',
            startDate: t.startDate,
            endDate: t.endDate || '',
            source: 'excel',
            createdAt: serverTimestamp()
          }
        );
        treatmentCount++;
      }

      // 選択された臨床イベントをインポート
      for (const idx of selectedEventIndices) {
        const e = parsedExcelEvents[idx];
        if (!e) continue;

        await addDoc(
          collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
          {
            eventType: e.eventType,
            startDate: e.startDate,
            endDate: e.endDate || '',
            severity: e.severity || '',
            note: e.note || '',
            source: 'excel',
            createdAt: serverTimestamp()
          }
        );
        eventCount++;
      }

      // 患者の検査件数を更新
      if (labCount > 0) {
        await updateDoc(doc(db, 'users', user.uid, 'patients', patient.id), {
          labCount: (labResults.length || 0) + labCount
        });
      }

      setShowExcelModal(false);
      setExcelData(null);
      setExcelSheets([]);
      setParsedExcelData([]);
      setParsedExcelTreatments([]);
      setParsedExcelEvents([]);
      setSelectedLabIndices([]);
      setSelectedTreatmentIndices([]);
      setSelectedEventIndices([]);
      setIsMultiSheetExcel(false);

      const messages = [];
      if (labCount > 0) messages.push(`検査データ: ${labCount}件`);
      if (treatmentCount > 0) messages.push(`治療データ: ${treatmentCount}件`);
      if (eventCount > 0) messages.push(`臨床イベント: ${eventCount}件`);
      alert(`インポート完了!\n${messages.join('\n')}`);
    } catch (err) {
      console.error('Error importing Excel data:', err);
      alert('インポートに失敗しました: ' + err.message);
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

  // 全治療データを一括削除
  const deleteAllTreatments = async () => {
    if (!confirm(`この患者の全治療データ（${treatments.length}件）を削除しますか？この操作は取り消せません。`)) return;

    try {
      for (const t of treatments) {
        await deleteDoc(
          doc(db, 'users', user.uid, 'patients', patient.id, 'treatments', t.id)
        );
      }
      alert('全治療データを削除しました');
    } catch (err) {
      console.error('Error deleting all treatments:', err);
      alert('削除に失敗しました');
    }
  };

  // 全臨床イベントを一括削除
  const deleteAllClinicalEvents = async () => {
    if (!confirm(`この患者の全臨床イベント（${clinicalEvents.length}件）を削除しますか？この操作は取り消せません。`)) return;

    try {
      for (const e of clinicalEvents) {
        await deleteDoc(
          doc(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents', e.id)
        );
      }
      alert('全臨床イベントを削除しました');
    } catch (err) {
      console.error('Error deleting all clinical events:', err);
      alert('削除に失敗しました');
    }
  };

  // 全データを一括削除（検査・治療・臨床イベント）
  const deleteAllPatientData = async () => {
    const totalCount = labResults.length + treatments.length + clinicalEvents.length;
    if (totalCount === 0) {
      alert('削除するデータがありません');
      return;
    }

    if (!confirm(`この患者の全データを削除しますか？\n\n検査データ: ${labResults.length}件\n治療データ: ${treatments.length}件\n臨床イベント: ${clinicalEvents.length}件\n\nこの操作は取り消せません。`)) return;

    try {
      // 検査データを削除
      for (const lab of labResults) {
        await deleteDoc(doc(db, 'users', user.uid, 'patients', patient.id, 'labResults', lab.id));
      }
      // 治療データを削除
      for (const t of treatments) {
        await deleteDoc(doc(db, 'users', user.uid, 'patients', patient.id, 'treatments', t.id));
      }
      // 臨床イベントを削除
      for (const e of clinicalEvents) {
        await deleteDoc(doc(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents', e.id));
      }

      await updateDoc(doc(db, 'users', user.uid, 'patients', patient.id), {
        labCount: 0
      });

      alert(`全データを削除しました（計${totalCount}件）`);
    } catch (err) {
      console.error('Error deleting all patient data:', err);
      alert('削除に失敗しました: ' + err.message);
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
          {(labResults.length > 0 || treatments.length > 0 || clinicalEvents.length > 0) && (
            <button
              onClick={deleteAllPatientData}
              style={{
                padding: '4px 10px',
                background: '#fef2f2',
                color: '#dc2626',
                border: '1px solid #fecaca',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}
              title="検査・治療・臨床イベントを全て削除"
            >
              <span>🗑️</span> 全データ削除
            </button>
          )}
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

        {/* セクションコンテナ（経過グラフを上、臨床経過と検査データを横並び） */}
        <div style={{display: 'flex', flexWrap: 'wrap', gap: '20px'}}>

        {/* 入力エリアヘッダー */}
        <div style={{
          flex: '1 1 100%',
          order: 2,
          background: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)',
          borderRadius: '12px',
          padding: '16px 20px',
          marginBottom: '-10px',
          border: '2px solid #86efac'
        }}>
          <h2 style={{
            fontSize: '18px',
            fontWeight: '700',
            color: '#166534',
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            📝 データ入力
          </h2>
          <p style={{fontSize: '12px', color: '#15803d', margin: '4px 0 0 0'}}>
            治療薬・症状・検査データを入力してください
          </p>
        </div>

        {/* 臨床経過セクション（治療薬と臨床イベントを統合） */}
        <section style={{...styles.section, flex: '1 1 400px', minWidth: '400px', order: 3}}>
          <h2 style={{
            fontSize: '16px',
            fontWeight: '700',
            color: '#1f2937',
            margin: '0 0 12px 0',
            padding: '0 0 8px 0',
            borderBottom: '2px solid #10b981'
          }}>
            💊 臨床経過（治療・症状）
          </h2>
          <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px'}}>
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

          {clinicalEvents.length === 0 && treatments.length === 0 ? (
            <div style={styles.emptyLab}>
              <p>臨床経過データはまだありません</p>
              <p style={{fontSize: '13px', marginTop: '8px'}}>
                治療薬や症状（意識障害、てんかん発作、不随意運動など）の経過を記録できます
              </p>
            </div>
          ) : (
            <>
              {/* 症状一覧ヘッダー */}
              {clinicalEvents.length > 0 && (
                <h4 style={{fontSize: '14px', fontWeight: '600', color: '#b45309', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px'}}>
                  <span>📋</span> 症状一覧
                </h4>
              )}

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

        {/* 経過グラフ作成セクション */}
        <section style={{...styles.section, flex: '1 1 100%', order: 1}}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>経過グラフ作成</h2>
            <button
              onClick={() => setShowTimeSeriesOverlay(!showTimeSeriesOverlay)}
              style={{
                ...styles.addLabButton,
                background: showTimeSeriesOverlay ? '#bfdbfe' : 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
                color: showTimeSeriesOverlay ? '#1d4ed8' : 'white',
                fontWeight: '600',
                padding: '10px 20px',
                fontSize: '14px'
              }}
            >
              <span>📊</span> {showTimeSeriesOverlay ? '閉じる' : '経過表を作成・出力'}
            </button>
          </div>
          {!showTimeSeriesOverlay && (
            <div style={{
              background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
              borderRadius: '8px',
              padding: '16px',
              border: '1px solid #bfdbfe'
            }}>
              <div style={{fontSize: '13px', color: '#1e40af', lineHeight: '1.6'}}>
                下の「データ入力」で入れたデータから、選択した<strong>検査値・治療薬・臨床経過</strong>を組み合わせた<strong>経過表</strong>を作成し、<strong>PNG画像</strong>や<strong>Excel</strong>で出力できます。
              </div>
              <div style={{fontSize: '12px', color: '#3b82f6', marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '12px'}}>
                <span>📊 検査値グラフ</span>
                <span>💊 治療薬タイムライン</span>
                <span>📋 臨床経過</span>
                <span>📐 二軸表示対応</span>
              </div>
              <div style={{fontSize: '11px', color: '#6b7280', marginTop: '8px'}}>
                💡 学会発表や論文用の経過表作成に最適です
              </div>
            </div>
          )}

          {showTimeSeriesOverlay && (
            <div style={{
              background: '#f8fafc',
              borderRadius: '12px',
              padding: '20px',
              border: '1px solid #e2e8f0'
            }}>
              {/* 操作ガイド */}
              <div style={{
                background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
                borderRadius: '8px',
                padding: '12px 16px',
                marginBottom: '20px',
                border: '1px solid #bfdbfe'
              }}>
                <div style={{fontSize: '13px', fontWeight: '600', color: '#1e40af', marginBottom: '8px'}}>
                  📋 経過表の作り方
                </div>
                <div style={{fontSize: '12px', color: '#3b82f6', lineHeight: '1.8'}}>
                  <div><span style={{fontWeight: '600', color: '#1e40af'}}>①</span> 下記から表示したい<strong>検査項目</strong>を選択（2つ以上で二軸表示可能）</div>
                  <div><span style={{fontWeight: '600', color: '#1e40af'}}>②</span> 必要に応じて<strong>治療薬</strong>や<strong>臨床経過</strong>を追加</div>
                  <div><span style={{fontWeight: '600', color: '#1e40af'}}>③</span> 「分離表示」または「重ね表示」を選択</div>
                  <div><span style={{fontWeight: '600', color: '#1e40af'}}>④</span> グラフ下のボタンで<strong>PNG画像</strong>や<strong>Excel</strong>に出力</div>
                </div>
                <div style={{fontSize: '11px', color: '#6b7280', marginTop: '8px', borderTop: '1px solid #bfdbfe', paddingTop: '8px'}}>
                  💡 <strong>二軸表示</strong>：スケールの異なる検査値（例：血糖とインスリン）を1つのグラフで比較できます
                </div>
              </div>

              {/* 検査項目選択 */}
              <div style={{marginBottom: '20px'}}>
                <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px'}}>
                  <h4 style={{fontSize: '14px', fontWeight: '600', color: '#1e40af', margin: 0}}>
                    検査項目を選択
                  </h4>
                  {selectedLabItemsForChart.length >= 2 && (
                    <label style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer'}}>
                      <input
                        type="checkbox"
                        checked={useDualAxis}
                        onChange={(e) => {
                          setUseDualAxis(e.target.checked);
                          if (!e.target.checked) setSecondaryAxisItems([]);
                        }}
                      />
                      <span style={{fontSize: '12px', color: '#6b7280'}}>二軸表示</span>
                    </label>
                  )}
                </div>
                {/* 二軸表示の使い方ヒント */}
                {selectedLabItemsForChart.length >= 2 && useDualAxis && (
                  <div style={{
                    background: '#fef3c7',
                    border: '1px solid #f59e0b',
                    borderRadius: '6px',
                    padding: '8px 12px',
                    marginBottom: '12px',
                    fontSize: '11px',
                    color: '#92400e'
                  }}>
                    <strong>二軸表示の使い方：</strong>
                    項目を<span style={{color: '#3b82f6', fontWeight: '600'}}>1回クリック→左軸（青）</span>、
                    <span style={{color: '#f59e0b', fontWeight: '600'}}>2回クリック→右軸（黄）</span>、
                    3回目で解除
                  </div>
                )}
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
                    // labResultsから全項目を抽出（採取日を除外）
                    const allItems = new Set();
                    labResults.forEach(lab => {
                      lab.data?.forEach(item => {
                        if (!item.item?.match(/^採取日?$/)) {
                          allItems.add(item.item);
                        }
                      });
                    });
                    return Array.from(allItems).sort().map(item => {
                      const isSelected = selectedLabItemsForChart.includes(item);
                      const isSecondaryAxis = secondaryAxisItems.includes(item);
                      return (
                        <div
                          key={item}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '4px 10px',
                            background: isSelected ? (isSecondaryAxis ? '#fef3c7' : '#dbeafe') : '#f1f5f9',
                            borderRadius: '16px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            border: isSelected ? `1px solid ${isSecondaryAxis ? '#f59e0b' : '#3b82f6'}` : '1px solid transparent'
                          }}
                          onClick={() => {
                            if (!isSelected) {
                              setSelectedLabItemsForChart(prev => [...prev, item]);
                            } else if (useDualAxis && !isSecondaryAxis) {
                              // 二軸モードで選択済み→右軸に移動
                              setSecondaryAxisItems(prev => [...prev, item]);
                            } else if (useDualAxis && isSecondaryAxis) {
                              // 右軸→選択解除
                              setSecondaryAxisItems(prev => prev.filter(i => i !== item));
                              setSelectedLabItemsForChart(prev => prev.filter(i => i !== item));
                            } else {
                              // 通常モード→選択解除
                              setSelectedLabItemsForChart(prev => prev.filter(i => i !== item));
                            }
                          }}
                        >
                          {item}
                          {useDualAxis && isSelected && (
                            <span style={{
                              fontSize: '9px',
                              padding: '1px 4px',
                              borderRadius: '4px',
                              background: isSecondaryAxis ? '#f59e0b' : '#3b82f6',
                              color: 'white',
                              marginLeft: '4px'
                            }}>
                              {isSecondaryAxis ? '右' : '左'}
                            </span>
                          )}
                        </div>
                      );
                    });
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

              {/* 表示オプション - 検査項目2つ以上または治療薬/臨床経過表示時に表示 */}
              {(selectedLabItemsForChart.length >= 2 || showTreatmentsOnChart || showEventsOnChart) && (
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
                  {/* ラベル表記・カラー設定 */}
                  <div style={{display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'center', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #bae6fd'}}>
                    <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                      <span style={{fontSize: '13px', fontWeight: '500', color: '#0369a1'}}>ラベル表記:</span>
                      <select
                        value={chartLabelStyle}
                        onChange={(e) => setChartLabelStyle(e.target.value)}
                        style={{padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '13px'}}
                      >
                        <option value="japanese">日本語</option>
                        <option value="english">英語</option>
                        <option value="abbreviation">略語</option>
                      </select>
                    </div>
                    <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                      <span style={{fontSize: '13px', fontWeight: '500', color: '#0369a1'}}>カラー:</span>
                      <select
                        value={chartColorStyle}
                        onChange={(e) => setChartColorStyle(e.target.value)}
                        style={{padding: '4px 8px', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '13px'}}
                      >
                        <option value="color">カラー</option>
                        <option value="monochrome">白黒</option>
                      </select>
                    </div>
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
                                  // 白黒モードの場合はグレースケールを使用
                                  const color = chartColorStyle === 'monochrome'
                                    ? (monochromeColors[group.category] || '#6b7280')
                                    : (categoryColors[group.category] || '#6b7280');
                                  const maxBarHeight = 40;
                                  const maxDosage = Math.max(...group.entries.map(e => parseFloat(e.dosage) || 0), 1);
                                  // 短縮名を取得（括弧内を除去）
                                  const shortName = group.name.replace(/（.*）/g, '').replace(/\(.*\)/g, '');
                                  // ラベル変換を適用
                                  const displayName = translateLabel(shortName);
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
                                        {displayName}{unitText}
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
                                  const defaultBarStyle = eventBarColors[group.type] || { bg: '#F8F9FA', border: '#ADB5BD' };
                                  // 白黒モードの場合はグレースケールを使用
                                  const barStyle = chartColorStyle === 'monochrome'
                                    ? { bg: monochromeEventColors[group.type] || '#6b7280', border: '#374151' }
                                    : defaultBarStyle;

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
                                        {translateLabel(group.type)}
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

                    // 検査データのグラフ（X軸をタイムラインと揃える）- 二軸対応
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
                          const isSecondary = useDualAxis && secondaryAxisItems.includes(item);
                          const baseColor = isSecondary
                            ? ['#f59e0b', '#f97316', '#ea580c', '#dc2626'][idx % 4]
                            : labColors[idx % labColors.length];
                          datasets.push({
                            label: item + (isSecondary ? ' [右]' : ''),
                            data: dataPoints,
                            borderColor: baseColor,
                            backgroundColor: baseColor,
                            tension: 0.2,
                            pointRadius: 4,
                            pointHoverRadius: 6,
                            borderWidth: 2,
                            yAxisID: isSecondary ? 'ySecondary' : 'y'
                          });
                        }
                      });

                      if (datasets.length === 0) return null;

                      const hasSecondaryLabData = useDualAxis && selectedLabItemsForChart.some(item => secondaryAxisItems.includes(item));

                      const scales = {
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
                          title: { display: true, text: '検査値（左軸）', color: '#3b82f6', font: { size: 11 } },
                          ticks: { color: '#3b82f6', font: { size: 10 } },
                          grid: { color: '#e5e7eb' }
                        }
                      };

                      if (hasSecondaryLabData) {
                        scales.ySecondary = {
                          type: 'linear',
                          position: 'right',
                          title: { display: true, text: '検査値（右軸）', color: '#f59e0b', font: { size: 11 } },
                          ticks: { color: '#f59e0b', font: { size: 10 } },
                          grid: { drawOnChartArea: false }
                        };
                      }

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
                              scales
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
                          const isSecondary = useDualAxis && secondaryAxisItems.includes(item);
                          const baseColor = isSecondary
                            ? ['#f59e0b', '#f97316', '#ea580c', '#dc2626'][idx % 4]
                            : labColors[idx % labColors.length];
                          datasets.push({
                            label: item + (isSecondary ? ' [右]' : ''),
                            data: dataPoints,
                            borderColor: baseColor,
                            backgroundColor: baseColor + '20',
                            tension: 0.2,
                            yAxisID: isSecondary ? 'ySecondary' : 'y',
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
                      const hasSecondaryLabData = useDualAxis && selectedLabItemsForChart.some(item => secondaryAxisItems.includes(item));
                      const hasTreatmentData = showTreatmentsOnChart && selectedTreatmentsForChart.length > 0;
                      const hasEventData = showEventsOnChart && selectedEventsForChart.length > 0;
                      const scales = { x: { type: 'linear', title: { display: true, text: 'days' } } };
                      if (hasLabData) scales.y = {
                        type: 'linear',
                        position: 'left',
                        title: { display: true, text: '検査値（左軸）', color: '#3b82f6' },
                        ticks: { color: '#3b82f6' },
                        grid: { color: '#e5e7eb' }
                      };
                      if (hasSecondaryLabData) scales.ySecondary = {
                        type: 'linear',
                        position: 'right',
                        title: { display: true, text: '検査値（右軸）', color: '#f59e0b' },
                        ticks: { color: '#f59e0b' },
                        grid: { drawOnChartArea: false }
                      };
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
        <section style={{...styles.section, flex: '1 1 400px', minWidth: '400px', order: 4}}>
          <h2 style={{
            fontSize: '16px',
            fontWeight: '700',
            color: '#1f2937',
            margin: '0 0 12px 0',
            padding: '0 0 8px 0',
            borderBottom: '2px solid #3b82f6'
          }}>
            🔬 検査データ
          </h2>
          <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px'}}>
              <button onClick={() => setShowAddLabModal(true)} style={styles.addLabButton}>
                <span>📷</span> 写真から追加
              </button>
              <button onClick={() => setShowExcelModal(true)} style={{...styles.addLabButton, background: '#e0f2fe', color: '#0369a1'}}>
                <span>📊</span> Excelから追加
              </button>
              <button onClick={() => setShowSummaryModal(true)} style={{...styles.addLabButton, background: '#fef3c7', color: '#92400e'}}>
                <span>📋</span> サマリーから作成
              </button>
              {labResults.length > 0 && (
                <button onClick={deleteAllLabResults} style={{...styles.addLabButton, background: '#fef2f2', color: '#dc2626'}}>
                  <span>🗑️</span> 全削除
                </button>
              )}
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
                      <span style={styles.labItemCount}>{lab.data?.filter(item => !item.item?.match(/^採取日?$/)).length || 0} 項目</span>
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
                    {lab.data?.filter(item => !item.item?.match(/^採取日?$/)).map((item, idx) => (
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
        </div>{/* セクションコンテナ閉じ */}
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
            <h2 style={styles.modalTitle}>
              {isMultiSheetExcel ? 'Excelから一括インポート' : 'Excelから検査データをインポート'}
            </h2>

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
                <div
                  style={{
                    ...styles.uploadArea,
                    border: isDraggingExcel ? '2px dashed #3b82f6' : '2px dashed #d1d5db',
                    background: isDraggingExcel ? '#eff6ff' : '#f9fafb'
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDraggingExcel(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setIsDraggingExcel(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDraggingExcel(false);
                    const file = e.dataTransfer.files[0];
                    if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
                      handleExcelUpload({ target: { files: [file] } });
                    } else {
                      alert('Excelファイル(.xlsx, .xls)をドロップしてください');
                    }
                  }}
                >
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
                      {isDraggingExcel ? 'ここにドロップ' : 'クリックまたはドラッグ＆ドロップ'}
                    </span>
                    <span style={styles.uploadHint}>
                      .xlsx または .xls ファイルに対応
                    </span>
                  </div>
                </label>
              </div>
              </>
            ) : isMultiSheetExcel ? (
              /* マルチシート形式のプレビュー */
              <div style={{maxHeight: '500px', overflowY: 'auto'}}>
                <div style={{background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '12px', marginBottom: '16px'}}>
                  <p style={{margin: 0, fontSize: '13px', color: '#0369a1'}}>
                    マルチシート形式のExcelを検出しました。インポートする項目を選択してください。
                  </p>
                </div>

                {/* 検査データプレビュー */}
                {parsedExcelData.length > 0 && (
                  <div style={{marginBottom: '20px'}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px'}}>
                      <h3 style={{fontSize: '14px', fontWeight: '600', color: '#374151', margin: 0}}>
                        検査データ ({selectedLabIndices.length}/{parsedExcelData.length}日分)
                      </h3>
                      <div style={{display: 'flex', gap: '8px'}}>
                        <button
                          onClick={() => setSelectedLabIndices(parsedExcelData.map((_, i) => i))}
                          style={{fontSize: '11px', padding: '4px 8px', background: '#e0f2fe', color: '#0369a1', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                        >全選択</button>
                        <button
                          onClick={() => setSelectedLabIndices([])}
                          style={{fontSize: '11px', padding: '4px 8px', background: '#f1f5f9', color: '#64748b', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                        >全解除</button>
                      </div>
                    </div>
                    <div style={{background: '#f8fafc', padding: '12px', borderRadius: '6px', maxHeight: '150px', overflow: 'auto'}}>
                      {parsedExcelData.map((dayData, idx) => (
                        <label key={idx} style={{display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', paddingBottom: '8px', borderBottom: idx < parsedExcelData.length - 1 ? '1px solid #e5e7eb' : 'none', cursor: 'pointer'}}>
                          <input
                            type="checkbox"
                            checked={selectedLabIndices.includes(idx)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedLabIndices([...selectedLabIndices, idx]);
                              } else {
                                setSelectedLabIndices(selectedLabIndices.filter(i => i !== idx));
                              }
                            }}
                          />
                          <strong style={{fontSize: '12px', color: '#1e40af'}}>{dayData.date}</strong>
                          <span style={{fontSize: '12px', color: '#6b7280'}}>
                            {dayData.data.length}項目
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* 治療データプレビュー */}
                {parsedExcelTreatments.length > 0 && (
                  <div style={{marginBottom: '20px'}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px'}}>
                      <h3 style={{fontSize: '14px', fontWeight: '600', color: '#374151', margin: 0}}>
                        治療データ ({selectedTreatmentIndices.length}/{parsedExcelTreatments.length}件)
                      </h3>
                      <div style={{display: 'flex', gap: '8px'}}>
                        <button
                          onClick={() => setSelectedTreatmentIndices(parsedExcelTreatments.map((_, i) => i))}
                          style={{fontSize: '11px', padding: '4px 8px', background: '#e0f2fe', color: '#0369a1', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                        >全選択</button>
                        <button
                          onClick={() => setSelectedTreatmentIndices([])}
                          style={{fontSize: '11px', padding: '4px 8px', background: '#f1f5f9', color: '#64748b', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                        >全解除</button>
                      </div>
                    </div>
                    <div style={{background: '#f8fafc', padding: '12px', borderRadius: '6px', maxHeight: '150px', overflow: 'auto'}}>
                      {parsedExcelTreatments.map((t, idx) => (
                        <label key={idx} style={{display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '13px', cursor: 'pointer'}}>
                          <input
                            type="checkbox"
                            checked={selectedTreatmentIndices.includes(idx)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedTreatmentIndices([...selectedTreatmentIndices, idx]);
                              } else {
                                setSelectedTreatmentIndices(selectedTreatmentIndices.filter(i => i !== idx));
                              }
                            }}
                          />
                          <strong>{t.medicationName}</strong>
                          {t.dosage && <span> {t.dosage}{t.dosageUnit}</span>}
                          <span style={{color: '#6b7280'}}>
                            {t.startDate} 〜 {t.endDate || '継続中'}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* 臨床イベントプレビュー */}
                {parsedExcelEvents.length > 0 && (
                  <div style={{marginBottom: '20px'}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px'}}>
                      <h3 style={{fontSize: '14px', fontWeight: '600', color: '#374151', margin: 0}}>
                        臨床イベント ({selectedEventIndices.length}/{parsedExcelEvents.length}件)
                      </h3>
                      <div style={{display: 'flex', gap: '8px'}}>
                        <button
                          onClick={() => setSelectedEventIndices(parsedExcelEvents.map((_, i) => i))}
                          style={{fontSize: '11px', padding: '4px 8px', background: '#e0f2fe', color: '#0369a1', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                        >全選択</button>
                        <button
                          onClick={() => setSelectedEventIndices([])}
                          style={{fontSize: '11px', padding: '4px 8px', background: '#f1f5f9', color: '#64748b', border: 'none', borderRadius: '4px', cursor: 'pointer'}}
                        >全解除</button>
                      </div>
                    </div>
                    <div style={{background: '#f8fafc', padding: '12px', borderRadius: '6px', maxHeight: '150px', overflow: 'auto'}}>
                      {parsedExcelEvents.map((e, idx) => (
                        <label key={idx} style={{display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px', fontSize: '13px', cursor: 'pointer'}}>
                          <input
                            type="checkbox"
                            checked={selectedEventIndices.includes(idx)}
                            onChange={(ev) => {
                              if (ev.target.checked) {
                                setSelectedEventIndices([...selectedEventIndices, idx]);
                              } else {
                                setSelectedEventIndices(selectedEventIndices.filter(i => i !== idx));
                              }
                            }}
                            style={{marginTop: '3px'}}
                          />
                          <div>
                            <strong>{e.eventType}</strong>
                            <span style={{color: '#6b7280', marginLeft: '8px'}}>{e.startDate}</span>
                            {e.note && <p style={{margin: '4px 0 0 0', fontSize: '12px', color: '#6b7280'}}>{e.note}</p>}
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {parsedExcelData.length === 0 && parsedExcelTreatments.length === 0 && parsedExcelEvents.length === 0 && (
                  <p style={{color: '#64748b', textAlign: 'center', padding: '40px'}}>
                    インポート可能なデータが見つかりませんでした
                  </p>
                )}
              </div>
            ) : (
              /* 従来形式のプレビュー */
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
                  setParsedExcelTreatments([]);
                  setParsedExcelEvents([]);
                  setSelectedLabIndices([]);
                  setSelectedTreatmentIndices([]);
                  setSelectedEventIndices([]);
                  setIsMultiSheetExcel(false);
                  setIsDraggingExcel(false);
                }}
                style={styles.cancelButton}
              >
                キャンセル
              </button>
              {excelData && (parsedExcelData.length > 0 || parsedExcelTreatments.length > 0 || parsedExcelEvents.length > 0) && (
                <button
                  onClick={importExcelData}
                  style={{
                    ...styles.primaryButton,
                    opacity: isImporting || (selectedLabIndices.length === 0 && selectedTreatmentIndices.length === 0 && selectedEventIndices.length === 0) ? 0.5 : 1
                  }}
                  disabled={isImporting || (selectedLabIndices.length === 0 && selectedTreatmentIndices.length === 0 && selectedEventIndices.length === 0)}
                >
                  {isImporting ? 'インポート中...' :
                    isMultiSheetExcel
                      ? `選択項目をインポート (${selectedLabIndices.length + selectedTreatmentIndices.length + selectedEventIndices.length}件)`
                      : `${selectedLabIndices.length}日分をインポート`
                  }
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* サマリー解析モーダル */}
      {showSummaryModal && (
        <div style={styles.modalOverlay}>
          <div style={{...styles.modal, maxWidth: '800px', maxHeight: '90vh', overflow: 'auto'}}>
            <h2 style={styles.modalTitle}>📋 サマリーから経過表を作成</h2>
            <p style={{fontSize: '13px', color: '#6b7280', marginBottom: '20px'}}>
              カルテサマリーの画像をアップロードすると、AIが検査値・治療薬・臨床経過を自動抽出します。
            </p>

            {summaryError && (
              <div style={{background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '12px', marginBottom: '16px'}}>
                <p style={{color: '#dc2626', fontSize: '13px', margin: 0}}>{summaryError}</p>
              </div>
            )}

            {!summaryResult ? (
              // 画像アップロード画面
              <div>
                <div
                  style={{
                    border: '2px dashed #d1d5db',
                    borderRadius: '12px',
                    padding: '40px',
                    textAlign: 'center',
                    background: summaryImage ? '#f0fdf4' : '#f9fafb',
                    cursor: 'pointer'
                  }}
                  onClick={() => document.getElementById('summaryImageInput').click()}
                >
                  <input
                    id="summaryImageInput"
                    type="file"
                    accept="image/*"
                    style={{display: 'none'}}
                    onChange={(e) => {
                      const file = e.target.files[0];
                      if (file) {
                        setSummaryImage(file);
                        setSummaryError('');
                      }
                    }}
                  />
                  {summaryImage ? (
                    <div>
                      <div style={{fontSize: '48px', marginBottom: '12px'}}>✅</div>
                      <p style={{fontWeight: '600', color: '#059669'}}>{summaryImage.name}</p>
                      <p style={{fontSize: '12px', color: '#6b7280'}}>クリックして変更</p>
                    </div>
                  ) : (
                    <div>
                      <div style={{fontSize: '48px', marginBottom: '12px'}}>📄</div>
                      <p style={{fontWeight: '600', color: '#374151'}}>画像をドロップまたはクリック</p>
                      <p style={{fontSize: '12px', color: '#6b7280'}}>対応形式: JPG, PNG, PDF</p>
                    </div>
                  )}
                </div>

                <div style={{marginTop: '20px', padding: '16px', background: '#fffbeb', borderRadius: '8px', border: '1px solid #fcd34d'}}>
                  <p style={{fontSize: '12px', color: '#92400e', margin: 0}}>
                    <strong>対応フォーマット:</strong> FUJITSU, IBM, NEC等の主要電子カルテ<br/>
                    <strong>注意:</strong> 個人情報（氏名・ID等）は自動で除外されますが、念のため確認してください
                  </p>
                </div>

                <div style={{...styles.modalActions, marginTop: '24px'}}>
                  <button
                    onClick={() => {
                      setShowSummaryModal(false);
                      setSummaryImage(null);
                      setSummaryResult(null);
                      setSummaryError('');
                    }}
                    style={styles.cancelButton}
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={async () => {
                      if (!summaryImage) {
                        setSummaryError('画像を選択してください');
                        return;
                      }
                      setSummaryProcessing(true);
                      setSummaryError('');
                      try {
                        const result = await processSummaryImage(summaryImage, (progress) => {
                          console.log('Progress:', progress);
                        });
                        if (result.success) {
                          setSummaryResult(result.data);
                        } else {
                          setSummaryError(result.error || '解析に失敗しました');
                        }
                      } catch (err) {
                        setSummaryError(err.message || '解析中にエラーが発生しました');
                      } finally {
                        setSummaryProcessing(false);
                      }
                    }}
                    disabled={!summaryImage || summaryProcessing}
                    style={{
                      ...styles.primaryButton,
                      backgroundColor: summaryProcessing ? '#9ca3af' : '#f59e0b',
                      cursor: summaryProcessing ? 'wait' : 'pointer'
                    }}
                  >
                    {summaryProcessing ? '解析中...' : 'AIで解析'}
                  </button>
                </div>
              </div>
            ) : (
              // 解析結果プレビュー画面
              <div>
                <div style={{marginBottom: '20px', padding: '12px', background: '#f0fdf4', borderRadius: '8px', border: '1px solid #86efac'}}>
                  <p style={{color: '#059669', fontSize: '13px', margin: 0, fontWeight: '500'}}>
                    ✅ 解析完了 - 内容を確認して登録してください
                  </p>
                </div>

                {/* 患者情報 */}
                {summaryResult.patientInfo && (
                  <div style={{marginBottom: '20px'}}>
                    <h3 style={{fontSize: '14px', fontWeight: '600', marginBottom: '8px', color: '#374151'}}>患者情報</h3>
                    <div style={{background: '#f8fafc', padding: '12px', borderRadius: '6px', fontSize: '13px'}}>
                      <p style={{margin: '4px 0'}}><strong>診断:</strong> {summaryResult.patientInfo.diagnosis || '不明'}</p>
                      <p style={{margin: '4px 0'}}><strong>発症日:</strong> {summaryResult.patientInfo.onsetDate || '不明'}</p>
                    </div>
                  </div>
                )}

                {/* 検査データ */}
                {summaryResult.labResults && summaryResult.labResults.length > 0 && (
                  <div style={{marginBottom: '20px'}}>
                    <h3 style={{fontSize: '14px', fontWeight: '600', marginBottom: '8px', color: '#374151'}}>
                      検査データ ({summaryResult.labResults.length}日分)
                    </h3>
                    <div style={{maxHeight: '150px', overflow: 'auto', background: '#f8fafc', padding: '12px', borderRadius: '6px'}}>
                      {summaryResult.labResults.map((lab, idx) => (
                        <div key={idx} style={{marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid #e5e7eb'}}>
                          <strong style={{fontSize: '12px', color: '#1e40af'}}>{lab.date}</strong>
                          <span style={{fontSize: '12px', color: '#6b7280', marginLeft: '8px'}}>
                            {lab.data?.length || 0}項目
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 治療薬 */}
                {summaryResult.treatments && summaryResult.treatments.length > 0 && (
                  <div style={{marginBottom: '20px'}}>
                    <h3 style={{fontSize: '14px', fontWeight: '600', marginBottom: '8px', color: '#374151'}}>
                      治療薬 ({summaryResult.treatments.length}件)
                    </h3>
                    <div style={{maxHeight: '150px', overflow: 'auto', background: '#f8fafc', padding: '12px', borderRadius: '6px'}}>
                      {summaryResult.treatments.map((t, idx) => (
                        <div key={idx} style={{marginBottom: '8px', fontSize: '13px'}}>
                          <strong>{t.medicationName}</strong>
                          {t.dosage && <span> {t.dosage}{t.dosageUnit}</span>}
                          <span style={{color: '#6b7280', marginLeft: '8px'}}>
                            {t.startDate} 〜 {t.endDate || '継続中'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 臨床イベント */}
                {summaryResult.clinicalEvents && summaryResult.clinicalEvents.length > 0 && (
                  <div style={{marginBottom: '20px'}}>
                    <h3 style={{fontSize: '14px', fontWeight: '600', marginBottom: '8px', color: '#374151'}}>
                      臨床イベント ({summaryResult.clinicalEvents.length}件)
                    </h3>
                    <div style={{maxHeight: '150px', overflow: 'auto', background: '#f8fafc', padding: '12px', borderRadius: '6px'}}>
                      {summaryResult.clinicalEvents.map((e, idx) => (
                        <div key={idx} style={{marginBottom: '8px', fontSize: '13px'}}>
                          <strong>{e.eventType}</strong>
                          <span style={{color: '#6b7280', marginLeft: '8px'}}>{e.startDate}</span>
                          {e.note && <p style={{margin: '4px 0 0 0', fontSize: '12px', color: '#6b7280'}}>{e.note}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{...styles.modalActions, marginTop: '24px'}}>
                  <button
                    onClick={() => {
                      setSummaryResult(null);
                      setSummaryImage(null);
                    }}
                    style={styles.cancelButton}
                  >
                    やり直す
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        let labCount = 0, treatmentCount = 0, eventCount = 0;

                        // 検査データを登録
                        if (summaryResult.labResults && summaryResult.labResults.length > 0) {
                          for (const lab of summaryResult.labResults) {
                            if (lab.date && lab.data && lab.data.length > 0) {
                              await addDoc(
                                collection(db, 'users', user.uid, 'patients', patient.id, 'labResults'),
                                {
                                  date: lab.date,
                                  data: lab.data,
                                  createdAt: serverTimestamp(),
                                  source: 'summary'
                                }
                              );
                              labCount++;
                            }
                          }
                        }

                        // 治療薬を登録
                        if (summaryResult.treatments && summaryResult.treatments.length > 0) {
                          for (const t of summaryResult.treatments) {
                            if (t.medicationName && t.startDate) {
                              await addDoc(
                                collection(db, 'users', user.uid, 'patients', patient.id, 'treatments'),
                                {
                                  category: t.category || 'その他',
                                  medicationName: t.medicationName,
                                  dosage: t.dosage || '',
                                  dosageUnit: t.dosageUnit || '',
                                  startDate: t.startDate,
                                  endDate: t.endDate || '',
                                  createdAt: serverTimestamp(),
                                  source: 'summary'
                                }
                              );
                              treatmentCount++;
                            }
                          }
                        }

                        // 臨床イベントを登録
                        if (summaryResult.clinicalEvents && summaryResult.clinicalEvents.length > 0) {
                          for (const e of summaryResult.clinicalEvents) {
                            if (e.eventType && e.startDate) {
                              await addDoc(
                                collection(db, 'users', user.uid, 'patients', patient.id, 'clinicalEvents'),
                                {
                                  eventType: e.eventType,
                                  startDate: e.startDate,
                                  endDate: e.endDate || '',
                                  severity: e.severity || '',
                                  note: e.note || '',
                                  createdAt: serverTimestamp(),
                                  source: 'summary'
                                }
                              );
                              eventCount++;
                            }
                          }
                        }

                        alert(`登録完了!\n検査データ: ${labCount}件\n治療薬: ${treatmentCount}件\n臨床イベント: ${eventCount}件`);
                        setShowSummaryModal(false);
                        setSummaryResult(null);
                        setSummaryImage(null);
                      } catch (error) {
                        console.error('データ登録エラー:', error);
                        alert('登録に失敗しました: ' + error.message);
                      }
                    }}
                    style={styles.primaryButton}
                  >
                    データを登録
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* フッター */}
      <footer style={{
        marginTop: '40px',
        paddingTop: '20px',
        borderTop: '1px solid #e5e7eb',
        textAlign: 'center',
        fontSize: '13px',
        color: '#6b7280'
      }}>
        <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={{color: '#2563eb', textDecoration: 'none', marginRight: '16px'}}>
          利用規約
        </a>
        <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{color: '#2563eb', textDecoration: 'none', marginRight: '16px'}}>
          プライバシーポリシー
        </a>
        <a href="/manual.html" target="_blank" rel="noopener noreferrer" style={{color: '#2563eb', textDecoration: 'none'}}>
          操作マニュアル
        </a>
      </footer>
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

// AuthProviderとOrganizationProviderでラップしてエクスポート
export default function AppWithAuth() {
  return (
    <AuthProvider>
      <OrganizationProvider>
        <App />
      </OrganizationProvider>
    </AuthProvider>
  );
}
