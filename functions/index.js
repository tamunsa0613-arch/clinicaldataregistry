/**
 * Cloud Functions - Cloud Vision OCR
 * 検査データの画像からテキストを抽出し、検査値を解析
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const vision = require("@google-cloud/vision");

// コスト管理のためのグローバル設定
setGlobalOptions({ maxInstances: 10, region: "asia-northeast1" });

// Vision APIクライアント
const visionClient = new vision.ImageAnnotatorClient();

// 検査項目のマッピング
const labItemMapping = {
  // 蛋白
  'TP': ['TP', '総蛋白', '総タンパク'],
  'Alb': ['Alb', 'ALB', 'アルブミン', 'ｱﾙﾌﾞﾐﾝ'],
  'A/G': ['A/G', 'A/G比', 'AG比'],

  // 腎機能
  'BUN': ['BUN', 'UN', '尿素窒素'],
  'Cr': ['Cr', 'CRE', 'クレアチニン', 'ｸﾚｱﾁﾆﾝ'],
  'eGFR': ['eGFR', 'EGFR', '推算GFR'],
  'Ccr': ['Ccr', 'CCR', '推算Ccr'],
  'UA': ['UA', '尿酸'],

  // 肝機能
  'AST': ['AST', 'GOT'],
  'ALT': ['ALT', 'GPT'],
  'γ-GTP': ['γ-GTP', 'GGT', 'γGTP', 'r-GTP', 'ガンマGTP'],
  'ALP': ['ALP', 'アルカリフォスファターゼ'],
  'LDH': ['LDH', 'LD', '乳酸脱水素酵素'],
  'T-Bil': ['T-Bil', 'TB', '総ビリルビン', '総ビ'],
  'D-Bil': ['D-Bil', 'DB', '直接ビリルビン', '直ビ', '直接ビ'],
  'I-Bil': ['I-Bil', '間接ビリルビン', '間接ビ', '間ビ'],
  'ChE': ['ChE', 'CHE', 'コリンエステラーゼ'],

  // 電解質
  'Na': ['Na', 'ナトリウム'],
  'K': ['K', 'カリウム'],
  'Cl': ['Cl', 'クロール'],
  'Ca': ['Ca', 'カルシウム'],
  'IP': ['IP', 'P', 'リン', '無機リン'],
  'Mg': ['Mg', 'マグネシウム'],
  'Fe': ['Fe', '鉄', '血清鉄'],
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
  'Ret': ['Ret', '網赤血球'],

  // 血液像
  'Baso': ['Baso', '好塩基球'],
  'Eosino': ['Eosino', 'Eos', '好酸球'],
  'Neut': ['Neut', 'Neu', '好中球', 'Neut-T'],
  'Lymph': ['Lymph', 'Lym', 'リンパ球'],
  'Mono': ['Mono', 'Mon', '単球'],
  'Seg': ['Seg', '分葉核球'],
  'Stab': ['Stab', '桿状核球'],

  // 炎症マーカー
  'CRP': ['CRP', 'C反応性蛋白'],
  'ESR': ['ESR', '赤沈', '血沈'],
  'PCT': ['PCT', 'プロカルシトニン'],

  // 凝固
  'PT': ['PT', 'プロトロンビン時間'],
  'APTT': ['APTT'],
  'Fib': ['Fib', 'フィブリノゲン', 'Fbg'],
  'D-dimer': ['D-dimer', 'Dダイマー', 'DD'],
  'FDP': ['FDP'],

  // 糖代謝
  'Glu': ['Glu', 'GLU', '血糖', 'BS', 'グルコース'],
  'HbA1c': ['HbA1c', 'A1c', 'ヘモグロビンA1c'],

  // 脂質
  'TC': ['TC', 'T-Cho', '総コレステロール'],
  'TG': ['TG', '中性脂肪', 'トリグリセリド'],
  'HDL': ['HDL', 'HDL-C', 'HDLコレステロール'],
  'LDL': ['LDL', 'LDL-C', 'LDLコレステロール'],

  // 心筋マーカー
  'CK': ['CK', 'CPK'],
  'CK-MB': ['CK-MB', 'CKMB'],
  'BNP': ['BNP'],
  'NT-proBNP': ['NT-proBNP'],

  // 甲状腺
  'TSH': ['TSH'],
  'FT3': ['FT3', '遊離T3'],
  'FT4': ['FT4', '遊離T4'],

  // 腫瘍マーカー
  'CA19-9': ['CA19-9', 'CA199'],
  'CA125': ['CA125'],
  'CEA': ['CEA'],
  'AFP': ['AFP'],
  'PSA': ['PSA'],
  'SCC': ['SCC'],

  // その他
  'Amy': ['Amy', 'AMY', 'アミラーゼ'],
  'Lip': ['Lip', 'リパーゼ'],
  'NH3': ['NH3', 'アンモニア'],

  // ============================================
  // 髄液検査（CSF）
  // ============================================
  'CSF細胞数': ['CSF細胞数', '髄液細胞数', '細胞数', '髄液細胞', 'CSF細胞'],
  'CSF蛋白': ['CSF蛋白', '髄液蛋白', '髄液タンパク', '髄液TP'],
  'CSF糖': ['CSF糖', '髄液糖', '髄液Glu'],
  'CSF-IgG': ['CSF-IgG', '髄液IgG', 'CSF IgG'],
  'IgG index': ['IgG index', 'IgGインデックス', 'IgG Index'],
  'CSF-Alb': ['CSF-Alb', '髄液アルブミン', '髄液Alb'],
  'Qalb': ['Qalb', 'Q-Alb', 'アルブミン商'],
  'OCB': ['OCB', 'オリゴクローナルバンド', 'オリゴクローナル'],
  'MBP': ['MBP', 'ミエリン塩基性蛋白', 'ミエリン塩基性タンパク'],

  // ============================================
  // 自己抗体（神経）
  // ============================================
  '抗NMDA受容体抗体': ['抗NMDA受容体抗体', 'NMDA受容体抗体', 'anti-NMDAR', 'NMDAR抗体'],
  '抗MOG抗体': ['抗MOG抗体', 'MOG抗体', 'anti-MOG', 'MOG-IgG'],
  '抗AQP4抗体': ['抗AQP4抗体', 'AQP4抗体', 'anti-AQP4', 'アクアポリン4抗体'],
  '抗GAD抗体': ['抗GAD抗体', 'GAD抗体', 'anti-GAD', 'GAD65抗体'],
  '抗VGCC抗体': ['抗VGCC抗体', 'VGCC抗体', 'P/Q型VGCC抗体'],
  '抗VGKC抗体': ['抗VGKC抗体', 'VGKC抗体', 'VGKC複合体抗体'],
  '抗LGI1抗体': ['抗LGI1抗体', 'LGI1抗体', 'anti-LGI1'],
  '抗CASPR2抗体': ['抗CASPR2抗体', 'CASPR2抗体', 'anti-CASPR2'],
  '抗Hu抗体': ['抗Hu抗体', 'Hu抗体', 'anti-Hu', 'ANNA-1'],
  '抗Yo抗体': ['抗Yo抗体', 'Yo抗体', 'anti-Yo', 'PCA-1'],
  '抗Ri抗体': ['抗Ri抗体', 'Ri抗体', 'anti-Ri', 'ANNA-2'],
  '抗AMPA受容体抗体': ['抗AMPA受容体抗体', 'AMPA受容体抗体', 'anti-AMPAR'],
  '抗GABA-B受容体抗体': ['抗GABA-B受容体抗体', 'GABA-B受容体抗体'],
  '抗GQ1b抗体': ['抗GQ1b抗体', 'GQ1b抗体', 'anti-GQ1b'],
  '抗GM1抗体': ['抗GM1抗体', 'GM1抗体', 'anti-GM1'],
  '抗GD1a抗体': ['抗GD1a抗体', 'GD1a抗体'],
  '抗アセチルコリン受容体抗体': ['抗AChR抗体', 'AChR抗体', 'アセチルコリン受容体抗体'],
  '抗MuSK抗体': ['抗MuSK抗体', 'MuSK抗体', 'anti-MuSK'],

  // ============================================
  // サイトカイン・炎症マーカー
  // ============================================
  'IL-6': ['IL-6', 'IL6', 'インターロイキン6', 'インターロイキン-6'],
  'IL-2': ['IL-2', 'IL2', 'インターロイキン2'],
  'IL-1β': ['IL-1β', 'IL-1b', 'IL1β', 'インターロイキン1β'],
  'IL-8': ['IL-8', 'IL8', 'インターロイキン8'],
  'IL-10': ['IL-10', 'IL10', 'インターロイキン10'],
  'TNF-α': ['TNF-α', 'TNFα', 'TNF-a', 'TNFa', '腫瘍壊死因子'],
  'IFN-γ': ['IFN-γ', 'IFNγ', 'IFN-g', 'インターフェロンγ'],
  'sIL-2R': ['sIL-2R', 'sIL2R', '可溶性IL-2受容体', '可溶性IL-2R'],
  'ネオプテリン': ['ネオプテリン', 'Neopterin'],
  'フェリチン': ['フェリチン', 'Ferritin', 'Fer'],
  'β2MG': ['β2MG', 'β2ミクログロブリン', 'β2-MG', 'B2MG'],

  // ============================================
  // 神経関連マーカー
  // ============================================
  'NSE': ['NSE', '神経特異的エノラーゼ', '神経特異エノラーゼ'],
  'S-100β': ['S-100β', 'S100β', 'S-100', 'S100', 'S100B'],
  'GFAP': ['GFAP', 'グリア線維性酸性蛋白'],
  'NfL': ['NfL', 'NFL', 'ニューロフィラメント軽鎖', 'ニューロフィラメントL'],
  'タウ蛋白': ['タウ蛋白', 'Tau', 'タウ', 'CSF-Tau'],
  'Aβ42': ['Aβ42', 'アミロイドβ42', 'Aβ1-42'],
  'Aβ40': ['Aβ40', 'アミロイドβ40', 'Aβ1-40'],
  '14-3-3蛋白': ['14-3-3蛋白', '14-3-3', '14-3-3タンパク'],

  // ============================================
  // 筋疾患関連
  // ============================================
  'アルドラーゼ': ['アルドラーゼ', 'ALD', 'Aldolase'],
  'ミオグロビン': ['ミオグロビン', 'Myoglobin', 'Mb'],

  // ============================================
  // 乳酸・ピルビン酸
  // ============================================
  'Lac': ['Lac', '乳酸', 'Lactate', '血中乳酸'],
  'Pyr': ['Pyr', 'ピルビン酸', 'Pyruvate', 'ピルビン酸'],
  'L/P比': ['L/P比', 'L/P', '乳酸/ピルビン酸比', '乳酸ピルビン酸比'],
  'CSF乳酸': ['CSF乳酸', '髄液乳酸', 'CSF-Lac'],
  'CSFピルビン酸': ['CSFピルビン酸', '髄液ピルビン酸', 'CSF-Pyr'],

  // ============================================
  // 血液ガス
  // ============================================
  'pH': ['pH', 'ペーハー'],
  'PaO2': ['PaO2', 'pO2', '動脈血酸素分圧', '酸素分圧'],
  'PaCO2': ['PaCO2', 'pCO2', '動脈血二酸化炭素分圧', '二酸化炭素分圧'],
  'HCO3': ['HCO3', 'HCO3-', '重炭酸イオン', '重炭酸'],
  'BE': ['BE', 'Base Excess', 'ベースエクセス', '塩基過剰'],
  'SaO2': ['SaO2', 'SpO2', '酸素飽和度', '動脈血酸素飽和度'],
  'AG': ['AG', 'Anion Gap', 'アニオンギャップ'],
  'A-aDO2': ['A-aDO2', 'AaDO2', '肺胞気動脈血酸素分圧較差'],

  // ============================================
  // 尿検査
  // ============================================
  '尿pH': ['尿pH', 'U-pH', '尿ペーハー'],
  '尿比重': ['尿比重', 'U-SG', 'SG'],
  '尿蛋白': ['尿蛋白', 'U-Pro', 'U-TP', '尿タンパク'],
  '尿蛋白定量': ['尿蛋白定量', '尿中蛋白', 'U-Pro定量'],
  '尿糖': ['尿糖', 'U-Glu', 'U-GLU'],
  '尿潜血': ['尿潜血', 'U-BLD', 'U-OB', '尿中潜血'],
  '尿ケトン': ['尿ケトン', 'U-Ket', 'ケトン体'],
  '尿ビリルビン': ['尿ビリルビン', 'U-Bil'],
  '尿ウロビリノーゲン': ['尿ウロビリノーゲン', 'U-Uro', 'ウロビリノーゲン'],
  '尿亜硝酸塩': ['尿亜硝酸塩', 'U-NIT', '亜硝酸'],
  '尿白血球': ['尿白血球', 'U-WBC', 'U-Leu', '尿中白血球'],
  '尿赤血球': ['尿赤血球', 'U-RBC', '尿中赤血球'],
  '尿円柱': ['尿円柱', '円柱'],
  '尿細菌': ['尿細菌', 'U-Bact', '細菌'],
  'NAG': ['NAG', 'U-NAG', '尿中NAG'],
  'β2MG(尿)': ['β2MG(尿)', '尿中β2MG', 'U-β2MG', 'U-B2MG'],
  'Alb/Cre比': ['Alb/Cre比', 'UACR', '尿アルブミン/クレアチニン比', 'ACR'],
  '尿中アルブミン': ['尿中アルブミン', 'U-Alb', '尿アルブミン'],
  'U-Cr': ['U-Cr', '尿クレアチニン', '尿中クレアチニン'],
  'Ccr(24時間)': ['Ccr(24時間)', '24時間Ccr', 'クレアチニンクリアランス'],
  '尿浸透圧': ['尿浸透圧', 'U-Osm', 'U-OSM'],
  '尿Na': ['尿Na', 'U-Na', '尿中Na', '尿中ナトリウム'],
  '尿K': ['尿K', 'U-K', '尿中K', '尿中カリウム'],
  '尿Cl': ['尿Cl', 'U-Cl', '尿中Cl', '尿中クロール'],
  'FENa': ['FENa', 'ナトリウム排泄分画'],
};

// 単位マッピング
const labItemUnits = {
  // 血算
  'WBC': '/μL', 'RBC': '×10⁴/μL', 'Hb': 'g/dL', 'Hct': '%', 'PLT': '×10⁴/μL',
  'MCV': 'fL', 'MCH': 'pg', 'MCHC': '%', 'Ret': '%',
  'Baso': '%', 'Eosino': '%', 'Neut': '%', 'Lymph': '%', 'Mono': '%',
  // 炎症
  'CRP': 'mg/dL', 'ESR': 'mm/h', 'PCT': 'ng/mL',
  // 肝機能
  'AST': 'U/L', 'ALT': 'U/L', 'γ-GTP': 'U/L', 'ALP': 'U/L', 'LDH': 'U/L',
  'T-Bil': 'mg/dL', 'D-Bil': 'mg/dL', 'I-Bil': 'mg/dL', 'ChE': 'U/L',
  // 腎機能
  'BUN': 'mg/dL', 'Cr': 'mg/dL', 'eGFR': 'mL/min/1.73m²', 'Ccr': 'mL/min', 'UA': 'mg/dL',
  // 電解質
  'Na': 'mEq/L', 'K': 'mEq/L', 'Cl': 'mEq/L', 'Ca': 'mg/dL', 'IP': 'mg/dL',
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
  'CK': 'U/L', 'CK-MB': 'U/L', 'BNP': 'pg/mL', 'NT-proBNP': 'pg/mL',
  // 甲状腺
  'TSH': 'μIU/mL', 'FT3': 'pg/mL', 'FT4': 'ng/dL',
  // 腫瘍マーカー
  'CA19-9': 'U/mL', 'CA125': 'U/mL', 'CEA': 'ng/mL', 'AFP': 'ng/mL', 'PSA': 'ng/mL', 'SCC': 'ng/mL',
  // 酵素
  'Amy': 'U/L', 'Lip': 'U/L', 'NH3': 'μg/dL',

  // ============================================
  // 髄液検査（CSF）
  // ============================================
  'CSF細胞数': '/μL', 'CSF蛋白': 'mg/dL', 'CSF糖': 'mg/dL',
  'CSF-IgG': 'mg/dL', 'IgG index': '', 'CSF-Alb': 'mg/dL', 'Qalb': '',
  'OCB': '', 'MBP': 'pg/mL',

  // ============================================
  // 自己抗体
  // ============================================
  '抗NMDA受容体抗体': '', '抗MOG抗体': '', '抗AQP4抗体': '',
  '抗GAD抗体': 'U/mL', '抗VGCC抗体': '', '抗VGKC抗体': '',
  '抗LGI1抗体': '', '抗CASPR2抗体': '',
  '抗Hu抗体': '', '抗Yo抗体': '', '抗Ri抗体': '',
  '抗AMPA受容体抗体': '', '抗GABA-B受容体抗体': '',
  '抗GQ1b抗体': '', '抗GM1抗体': '', '抗GD1a抗体': '',
  '抗アセチルコリン受容体抗体': 'nmol/L', '抗MuSK抗体': '',

  // ============================================
  // サイトカイン
  // ============================================
  'IL-6': 'pg/mL', 'IL-2': 'pg/mL', 'IL-1β': 'pg/mL', 'IL-8': 'pg/mL', 'IL-10': 'pg/mL',
  'TNF-α': 'pg/mL', 'IFN-γ': 'pg/mL',
  'sIL-2R': 'U/mL', 'ネオプテリン': 'nmol/L',
  'フェリチン': 'ng/mL', 'β2MG': 'mg/L',

  // ============================================
  // 神経関連マーカー
  // ============================================
  'NSE': 'ng/mL', 'S-100β': 'pg/mL', 'GFAP': 'pg/mL', 'NfL': 'pg/mL',
  'タウ蛋白': 'pg/mL', 'Aβ42': 'pg/mL', 'Aβ40': 'pg/mL', '14-3-3蛋白': '',

  // ============================================
  // 筋疾患関連
  // ============================================
  'アルドラーゼ': 'U/L', 'ミオグロビン': 'ng/mL',

  // ============================================
  // 乳酸・ピルビン酸
  // ============================================
  'Lac': 'mmol/L', 'Pyr': 'mg/dL', 'L/P比': '',
  'CSF乳酸': 'mmol/L', 'CSFピルビン酸': 'mg/dL',

  // ============================================
  // 血液ガス
  // ============================================
  'pH': '', 'PaO2': 'mmHg', 'PaCO2': 'mmHg',
  'HCO3': 'mEq/L', 'BE': 'mEq/L', 'SaO2': '%',
  'AG': 'mEq/L', 'A-aDO2': 'mmHg',

  // ============================================
  // 尿検査
  // ============================================
  '尿pH': '', '尿比重': '', '尿蛋白': '', '尿蛋白定量': 'mg/日',
  '尿糖': '', '尿潜血': '', '尿ケトン': '', '尿ビリルビン': '',
  '尿ウロビリノーゲン': '', '尿亜硝酸塩': '', '尿白血球': '/HPF', '尿赤血球': '/HPF',
  '尿円柱': '/LPF', '尿細菌': '',
  'NAG': 'U/L', 'β2MG(尿)': 'μg/L',
  'Alb/Cre比': 'mg/gCr', '尿中アルブミン': 'mg/日',
  'U-Cr': 'mg/dL', 'Ccr(24時間)': 'mL/min',
  '尿浸透圧': 'mOsm/kg', '尿Na': 'mEq/L', '尿K': 'mEq/L', '尿Cl': 'mEq/L',
  'FENa': '%',
};

// 個人情報除外パターン
const piiPatterns = [
  /患者(名|氏名|ID|番号)\s*[:：]?\s*[\u4e00-\u9faf\u3040-\u309f\u30a0-\u30ffA-Za-z0-9]+/g,
  /〒?\d{3}-?\d{4}/g,
  /[\u4e00-\u9faf]+[都道府県][\u4e00-\u9faf]+[市区町村]/g,
  /\d{4}[年\/\-]\d{1,2}[月\/\-]\d{1,2}[日]?\s*(生|生年月日)/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\d{2,4}-\d{2,4}-\d{4}/g,
  /(様|殿|御中)/g,
];

// 項目名を正規化
function normalizeLabItem(rawName) {
  const cleaned = rawName.trim()
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[ー−]/g, '-');

  for (const [normalizedName, aliases] of Object.entries(labItemMapping)) {
    for (const alias of aliases) {
      // 完全一致
      if (cleaned === alias || cleaned.toLowerCase() === alias.toLowerCase()) {
        return normalizedName;
      }
      // 括弧付き表記 (例: "AST(GOT)")
      if (cleaned.includes('(') && cleaned.split('(')[0] === alias) {
        return normalizedName;
      }
      // 部分一致（日本語項目名）
      if (alias.length >= 3 && cleaned.includes(alias)) {
        return normalizedName;
      }
    }
  }
  return null;
}

// テキストから検査値を抽出
function extractLabData(text) {
  // 個人情報を除去
  let cleanedText = text;
  piiPatterns.forEach(pattern => {
    cleanedText = cleanedText.replace(pattern, '[REMOVED]');
  });

  const lines = cleanedText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const extractedData = [];
  const foundItems = new Set();

  // 方法1: 項目名を見つけたら、同じ行または次の行から数値を取得
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const withoutLineNum = line.replace(/^\d+\s+/, '');

    // 各検査項目を探す
    for (const [normalizedName, aliases] of Object.entries(labItemMapping)) {
      if (foundItems.has(normalizedName)) continue;

      for (const alias of aliases) {
        // この行に項目名が含まれているか
        if (withoutLineNum.includes(alias) || line.includes(alias)) {
          // 同じ行に数値があるか確認
          let value = null;

          // パターン1: 項目名の後に数値 (例: "AST (GOT) 64")
          const sameLineMatch = line.match(new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\d]*(\\d+\\.?\\d*)'));
          if (sameLineMatch && sameLineMatch[1]) {
            value = parseFloat(sameLineMatch[1]);
          }

          // パターン2: 次の行に数値がある (Cloud Visionの出力形式)
          if (value === null && i + 1 < lines.length) {
            const nextLine = lines[i + 1];
            // 次の行が数値で始まる場合
            const nextLineMatch = nextLine.match(/^([\d.]+)\s*[HLN]?/);
            if (nextLineMatch) {
              value = parseFloat(nextLineMatch[1]);
            }
          }

          if (value !== null && !isNaN(value) && value >= 0) {
            extractedData.push({
              item: normalizedName,
              value: value,
              unit: labItemUnits[normalizedName] || ''
            });
            foundItems.add(normalizedName);
            break;
          }
        }
      }
    }
  }

  // 方法2: 全テキストからパターンマッチ（フォールバック）
  const fullText = cleanedText.replace(/\n/g, ' ');

  const directPatterns = [
    { name: 'TP', pattern: /(?:TP|総蛋白)[^0-9]*([\d.]+)/i },
    { name: 'Alb', pattern: /(?:アルブミン|Alb)[^0-9]*([\d.]+)/i },
    { name: 'A/G', pattern: /A\/G[^0-9]*([\d.]+)/i },
    { name: 'BUN', pattern: /(?:UN|BUN|尿素窒素)[^0-9]*([\d.]+)/i },
    { name: 'Cr', pattern: /(?:CRE|クレアチニン)[^0-9]*([\d.]+)/i },
    { name: 'eGFR', pattern: /eGFR[^0-9]*([\d.]+)/i },
    { name: 'AST', pattern: /(?:AST|GOT)[^0-9]*(\d+)/i },
    { name: 'ALT', pattern: /(?:ALT|GPT)[^0-9]*(\d+)/i },
    { name: 'ALP', pattern: /ALP[^0-9]*(\d+)/i },
    { name: 'LDH', pattern: /LDH[^0-9]*(\d+)/i },
    { name: 'T-Bil', pattern: /(?:T-Bil|総ビリルビン)[^0-9]*([\d.]+)/i },
    { name: 'D-Bil', pattern: /(?:D-Bil|直接ビリルビン)[^0-9]*([\d.]+)/i },
    { name: 'I-Bil', pattern: /間接ビリルビン[^0-9]*([\d.]+)/i },
    { name: 'Na', pattern: /Na[^0-9]*(\d+)/i },
    { name: 'K', pattern: /(?:K|カリウム)[^0-9]*([\d.]+)/i },
    { name: 'Cl', pattern: /(?:Cl|クロール)[^0-9]*(\d+)/i },
    { name: 'Ca', pattern: /(?:Ca|カルシウム)[^0-9]*([\d.]+)/i },
    { name: '補正Ca', pattern: /補正Ca[^0-9]*([\d.]+)/i },
    { name: 'IP', pattern: /(?:IP|無機リン|無機P)[^0-9]*([\d.]+)/i },
    { name: 'Mg', pattern: /(?:Mg|マグネシウム)[^0-9]*([\d.]+)/i },
    { name: 'WBC', pattern: /(?:WBC|白血球)[^0-9]*(\d+)/i },
    { name: 'RBC', pattern: /(?:RBC|赤血球)[^0-9]*(\d+)/i },
    { name: 'Hb', pattern: /(?:Hb|ヘモグロビン)[^0-9]*([\d.]+)/i },
    { name: 'Hct', pattern: /(?:Hct|ヘマトクリット)[^0-9]*([\d.]+)/i },
    { name: 'PLT', pattern: /(?:PLT|血小板)[^0-9]*([\d.]+)/i },
    { name: 'MCV', pattern: /MCV[^0-9]*([\d.]+)/i },
    { name: 'MCH', pattern: /MCH[^0-9]*([\d.]+)/i },
    { name: 'MCHC', pattern: /MCHC[^0-9]*([\d.]+)/i },
    { name: 'CRP', pattern: /CRP[^0-9]*([\d.]+)/i },
    { name: 'CA19-9', pattern: /CA19-9[^0-9]*([\d.]+)/i },
    { name: 'CA125', pattern: /CA125[^0-9]*([\d.]+)/i },
    { name: 'Ccr', pattern: /(?:推算Ccr|Ccr)[^0-9]*([\d.]+)/i },
    { name: 'γ-GTP', pattern: /[γr]-?GTP[^0-9]*(\d+)/i },
    { name: 'Neut', pattern: /Neut[^0-9]*([\d.]+)/i },
    { name: 'Lymph', pattern: /Lymph[^0-9]*([\d.]+)/i },
    { name: 'Mono', pattern: /Mono[^0-9]*([\d.]+)/i },
    { name: 'Eosino', pattern: /Eosino[^0-9]*([\d.]+)/i },
    { name: 'Baso', pattern: /Baso[^0-9]*([\d.]+)/i },

    // 髄液検査
    { name: 'CSF細胞数', pattern: /(?:CSF細胞数|髄液細胞数|細胞数)[^0-9]*(\d+)/i },
    { name: 'CSF蛋白', pattern: /(?:CSF蛋白|髄液蛋白)[^0-9]*([\d.]+)/i },
    { name: 'CSF糖', pattern: /(?:CSF糖|髄液糖)[^0-9]*([\d.]+)/i },
    { name: 'IgG index', pattern: /IgG\s*index[^0-9]*([\d.]+)/i },
    { name: 'MBP', pattern: /MBP[^0-9]*([\d.]+)/i },
    { name: 'OCB', pattern: /(?:OCB|オリゴクローナル)[^0-9]*(\d+)/i },

    // サイトカイン
    { name: 'IL-6', pattern: /IL-?6[^0-9]*([\d.]+)/i },
    { name: 'IL-2', pattern: /IL-?2[^0-9]*([\d.]+)/i },
    { name: 'TNF-α', pattern: /TNF-?[αa][^0-9]*([\d.]+)/i },
    { name: 'sIL-2R', pattern: /sIL-?2R[^0-9]*([\d.]+)/i },
    { name: 'ネオプテリン', pattern: /ネオプテリン[^0-9]*([\d.]+)/i },
    { name: 'フェリチン', pattern: /(?:フェリチン|Ferritin)[^0-9]*([\d.]+)/i },

    // 神経マーカー
    { name: 'NSE', pattern: /NSE[^0-9]*([\d.]+)/i },
    { name: 'S-100β', pattern: /S-?100[^0-9]*([\d.]+)/i },
    { name: 'NfL', pattern: /(?:NfL|NFL)[^0-9]*([\d.]+)/i },
    { name: 'タウ蛋白', pattern: /(?:タウ|Tau)[^0-9]*([\d.]+)/i },

    // 乳酸・ピルビン酸
    { name: 'Lac', pattern: /(?:Lac|乳酸)[^0-9]*([\d.]+)/i },
    { name: 'Pyr', pattern: /(?:Pyr|ピルビン酸)[^0-9]*([\d.]+)/i },
    { name: 'L/P比', pattern: /L\/P[^0-9]*([\d.]+)/i },

    // 血液ガス
    { name: 'pH', pattern: /pH[^0-9]*([\d.]+)/i },
    { name: 'PaO2', pattern: /(?:PaO2|pO2)[^0-9]*([\d.]+)/i },
    { name: 'PaCO2', pattern: /(?:PaCO2|pCO2)[^0-9]*([\d.]+)/i },
    { name: 'HCO3', pattern: /HCO3[^0-9]*([\d.]+)/i },
    { name: 'BE', pattern: /BE[^0-9\-]*(-?[\d.]+)/i },
    { name: 'SaO2', pattern: /(?:SaO2|SpO2)[^0-9]*([\d.]+)/i },

    // 尿検査
    { name: '尿蛋白定量', pattern: /尿蛋白定量[^0-9]*([\d.]+)/i },
    { name: 'NAG', pattern: /NAG[^0-9]*([\d.]+)/i },
    { name: 'Alb/Cre比', pattern: /(?:Alb\/Cre|UACR|ACR)[^0-9]*([\d.]+)/i },
    { name: '尿浸透圧', pattern: /尿浸透圧[^0-9]*([\d.]+)/i },
    { name: 'FENa', pattern: /FENa[^0-9]*([\d.]+)/i },
  ];

  for (const { name, pattern } of directPatterns) {
    if (foundItems.has(name)) continue;
    const match = fullText.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1]);
      if (!isNaN(value) && value >= 0) {
        extractedData.push({
          item: name,
          value: value,
          unit: labItemUnits[name] || ''
        });
        foundItems.add(name);
      }
    }
  }

  console.log('Found items:', Array.from(foundItems));
  return extractedData;
}

// メインのOCR関数
exports.processLabImage = onCall(
  { cors: true, maxInstances: 10 },
  async (request) => {
    // 認証チェック
    if (!request.auth) {
      throw new HttpsError('unauthenticated', '認証が必要です');
    }

    const { imageBase64 } = request.data;

    if (!imageBase64) {
      throw new HttpsError('invalid-argument', '画像データが必要です');
    }

    try {
      // Base64からBufferに変換
      const imageBuffer = Buffer.from(imageBase64, 'base64');

      // Cloud Vision APIでテキスト検出
      const [result] = await visionClient.textDetection({
        image: { content: imageBuffer }
      });

      const detections = result.textAnnotations;

      if (!detections || detections.length === 0) {
        return {
          success: true,
          data: [],
          message: 'テキストが検出されませんでした'
        };
      }

      // 最初の要素が全テキスト
      const fullText = detections[0].description;
      console.log('OCR Full Text:', fullText);

      // 検査値を抽出
      const extractedData = extractLabData(fullText);

      return {
        success: true,
        data: extractedData,
        itemsFound: extractedData.length,
        rawTextLength: fullText.length
      };

    } catch (error) {
      console.error('Vision API Error:', error);
      throw new HttpsError('internal', `OCR処理エラー: ${error.message}`);
    }
  }
);

// ============================================================
// カルテサマリー解析機能
// Cloud Vision OCR + Claude API で構造化データを抽出
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");

// Claude APIクライアント（APIキーは環境変数から取得）
let anthropicClient = null;

function getAnthropicClient() {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY環境変数が設定されていません');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// カルテサマリーから構造化データを抽出するプロンプト
const SUMMARY_EXTRACTION_PROMPT = `あなたは医療データ抽出の専門家です。以下のカルテサマリーのテキストから、臨床経過表を作成するためのデータを抽出してください。

## 抽出するデータ

1. **検査データ** (labResults)
   - 日付、検査項目名、数値、単位

2. **治療薬** (treatments)
   - 薬剤名、カテゴリ（抗てんかん薬、ステロイド、免疫グロブリン、血漿交換、免疫抑制剤、抗菌薬、その他）
   - 用量、単位、開始日、終了日（分かる場合）

3. **臨床イベント** (clinicalEvents)
   - 日付、イベント種類（発熱、痙攣、意識障害、画像所見、入院、退院、手術など）
   - 詳細・メモ

## 出力形式

以下のJSON形式で出力してください。日付は"YYYY-MM-DD"形式、不明な場合はnullとしてください。

\`\`\`json
{
  "patientInfo": {
    "diagnosis": "診断名",
    "onsetDate": "発症日（推定）"
  },
  "labResults": [
    {
      "date": "2025-01-15",
      "data": [
        {"item": "WBC", "value": 8500, "unit": "/μL"},
        {"item": "CRP", "value": 2.5, "unit": "mg/dL"}
      ]
    }
  ],
  "treatments": [
    {
      "category": "ステロイド",
      "medicationName": "メチルプレドニゾロン",
      "dosage": 1000,
      "dosageUnit": "mg",
      "startDate": "2025-01-15",
      "endDate": "2025-01-17",
      "note": "パルス療法"
    }
  ],
  "clinicalEvents": [
    {
      "eventType": "痙攣",
      "startDate": "2025-01-14",
      "endDate": null,
      "note": "全身性強直間代発作、約2分間"
    }
  ]
}
\`\`\`

## 注意事項
- 検査項目名は一般的な略称（WBC, CRP, AST, ALTなど）に正規化してください
- 日付が「第○病日」などの相対表記の場合、可能なら絶対日付に変換してください
- 不確かな情報は抽出しないでください
- 個人を特定できる情報（氏名、ID、住所など）は除外してください

## カルテサマリーテキスト

`;

// サマリー画像を処理するCloud Function
exports.processSummaryImage = onCall(
  {
    cors: true,
    maxInstances: 10,
    timeoutSeconds: 120, // 長めのタイムアウト
    memory: "512MiB",
    secrets: ["ANTHROPIC_API_KEY"]
  },
  async (request) => {
    // 認証チェック
    if (!request.auth) {
      throw new HttpsError('unauthenticated', '認証が必要です');
    }

    const { imageBase64 } = request.data;

    if (!imageBase64) {
      throw new HttpsError('invalid-argument', '画像データが必要です');
    }

    try {
      // Step 1: Cloud Vision APIでOCR
      console.log('Step 1: Running OCR...');
      const imageBuffer = Buffer.from(imageBase64, 'base64');

      const [visionResult] = await visionClient.textDetection({
        image: { content: imageBuffer }
      });

      const detections = visionResult.textAnnotations;

      if (!detections || detections.length === 0) {
        return {
          success: false,
          error: 'テキストが検出されませんでした。画像を確認してください。'
        };
      }

      const ocrText = detections[0].description;
      console.log('OCR Text Length:', ocrText.length);

      // 個人情報を除去
      let cleanedText = ocrText;
      piiPatterns.forEach(pattern => {
        cleanedText = cleanedText.replace(pattern, '[個人情報削除]');
      });

      // Step 2: Claude APIで構造化
      console.log('Step 2: Structuring with Claude API...');

      const client = getAnthropicClient();

      const message = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: SUMMARY_EXTRACTION_PROMPT + cleanedText
          }
        ]
      });

      // レスポンスからJSONを抽出
      const responseText = message.content[0].text;
      console.log('Claude Response Length:', responseText.length);

      // JSONブロックを抽出
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/);
      let extractedData;

      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[1]);
      } else {
        // JSONブロックがない場合、全体をパースしてみる
        try {
          extractedData = JSON.parse(responseText);
        } catch (e) {
          throw new Error('Claude APIの応答からJSONを抽出できませんでした');
        }
      }

      return {
        success: true,
        data: extractedData,
        ocrTextLength: ocrText.length,
        message: 'サマリーの解析が完了しました'
      };

    } catch (error) {
      console.error('Summary Processing Error:', error);

      if (error.message.includes('ANTHROPIC_API_KEY')) {
        throw new HttpsError('failed-precondition', 'Claude APIキーが設定されていません。Firebase Functionsの環境変数を確認してください。');
      }

      throw new HttpsError('internal', `サマリー処理エラー: ${error.message}`);
    }
  }
);

// サマリーテキストから構造化データを抽出するCloud Function
exports.parseSummaryText = onCall(
  {
    cors: true,
    maxInstances: 10,
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: ["ANTHROPIC_API_KEY"]
  },
  async (request) => {
    // 認証チェック
    if (!request.auth) {
      throw new HttpsError('unauthenticated', '認証が必要です');
    }

    const { text } = request.data;

    if (!text || text.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'テキストを入力してください');
    }

    if (text.length > 50000) {
      throw new HttpsError('invalid-argument', 'テキストが長すぎます（最大50,000文字）');
    }

    try {
      console.log('parseSummaryText: Input text length:', text.length);

      // 個人情報を除去
      let cleanedText = text;
      piiPatterns.forEach(pattern => {
        cleanedText = cleanedText.replace(pattern, '[個人情報削除]');
      });

      // Claude APIで構造化
      console.log('Structuring with Claude API...');
      const client = getAnthropicClient();

      const message = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: SUMMARY_EXTRACTION_PROMPT + cleanedText
          }
        ]
      });

      // レスポンスからJSONを抽出
      const responseText = message.content[0].text;
      console.log('Claude Response Length:', responseText.length);

      // JSONブロックを抽出
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/);
      let extractedData;

      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[1]);
      } else {
        try {
          extractedData = JSON.parse(responseText);
        } catch (e) {
          throw new Error('Claude APIの応答からJSONを抽出できませんでした');
        }
      }

      return {
        success: true,
        data: extractedData,
        inputTextLength: text.length,
        message: 'サマリーテキストの解析が完了しました'
      };

    } catch (error) {
      console.error('parseSummaryText Error:', error);

      if (error.message.includes('ANTHROPIC_API_KEY')) {
        throw new HttpsError('failed-precondition', 'Claude APIキーが設定されていません。Firebase Functionsの環境変数を確認してください。');
      }

      throw new HttpsError('internal', `テキスト解析エラー: ${error.message}`);
    }
  }
);
