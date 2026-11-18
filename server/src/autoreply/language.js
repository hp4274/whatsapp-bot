/**
 * The language registry and detector. Cheap and offline:
 *   1. the script the letters are in (Gujarati letters are Gujarati; Hangul is Korean);
 *   2. inside a script shared by several languages (Devanagari, Arabic, Cyrillic, Latin),
 *      telltale letters and common words ("kem cho" is Gujarati in English letters,
 *      "kya hai" Hindi, "hola" Spanish).
 * Language and script are separate: 'gujlish' is Gujarati written in English letters.
 *
 * Every result has a confidence (0..1). Short messages ("ok", "👍") are low; the
 * engine then falls back on the contact's saved language or their recent messages.
 *
 * Adding a language is a registry entry (and, for a Latin- or shared-script one,
 * a few marker words below); the engine never changes.
 * shortcut: marker words, not a trained model; swap detect() for a library (e.g. cld3, AI4Bharat
 * IndicLID) when the Activity log shows misses.
 */

/**
 * code, label, script ('native' = its own letters, 'roman' = written in English letters),
 * and `detect`: false where the detector cannot tell it apart (replies can still be written for it,
 * and a contact can choose it).
 */
export const LANGUAGES = Object.freeze([
    // India
    { code: 'en', label: 'English', script: 'latin', detect: true },
    { code: 'hi', label: 'Hindi', script: 'native', detect: true },
    { code: 'hinglish', label: 'Hinglish (Hindi in English letters)', script: 'roman', detect: true },
    { code: 'gu', label: 'Gujarati', script: 'native', detect: true },
    { code: 'gujlish', label: 'Gujlish (Gujarati in English letters)', script: 'roman', detect: true },
    { code: 'mr', label: 'Marathi', script: 'native', detect: true },
    { code: 'bn', label: 'Bengali', script: 'native', detect: true },
    { code: 'pa', label: 'Punjabi', script: 'native', detect: true },
    { code: 'ta', label: 'Tamil', script: 'native', detect: true },
    { code: 'te', label: 'Telugu', script: 'native', detect: true },
    { code: 'kn', label: 'Kannada', script: 'native', detect: true },
    { code: 'ml', label: 'Malayalam', script: 'native', detect: true },
    { code: 'or', label: 'Odia', script: 'native', detect: true },
    { code: 'as', label: 'Assamese', script: 'native', detect: true },
    { code: 'ur', label: 'Urdu', script: 'native', detect: true },
    { code: 'ne', label: 'Nepali', script: 'native', detect: true },
    { code: 'mni', label: 'Manipuri (Meetei Mayek)', script: 'native', detect: true },
    { code: 'sat', label: 'Santali (Ol Chiki)', script: 'native', detect: true },
    { code: 'sa', label: 'Sanskrit', script: 'native', detect: false },
    { code: 'ks', label: 'Kashmiri', script: 'native', detect: false },
    { code: 'kok', label: 'Konkani', script: 'native', detect: false },
    { code: 'sd', label: 'Sindhi', script: 'native', detect: false },
    { code: 'brx', label: 'Bodo', script: 'native', detect: false },
    { code: 'doi', label: 'Dogri', script: 'native', detect: false },
    { code: 'mai', label: 'Maithili', script: 'native', detect: false },
    // International
    { code: 'es', label: 'Spanish', script: 'latin', detect: true },
    { code: 'fr', label: 'French', script: 'latin', detect: true },
    { code: 'de', label: 'German', script: 'latin', detect: true },
    { code: 'pt', label: 'Portuguese', script: 'latin', detect: true },
    { code: 'it', label: 'Italian', script: 'latin', detect: true },
    { code: 'nl', label: 'Dutch', script: 'latin', detect: true },
    { code: 'ru', label: 'Russian', script: 'native', detect: true },
    { code: 'uk', label: 'Ukrainian', script: 'native', detect: true },
    { code: 'ar', label: 'Arabic', script: 'native', detect: true },
    { code: 'fa', label: 'Persian', script: 'native', detect: true },
    { code: 'tr', label: 'Turkish', script: 'latin', detect: true },
    { code: 'zh', label: 'Chinese', script: 'native', detect: true },
    { code: 'ja', label: 'Japanese', script: 'native', detect: true },
    { code: 'ko', label: 'Korean', script: 'native', detect: true },
    { code: 'th', label: 'Thai', script: 'native', detect: true },
    { code: 'vi', label: 'Vietnamese', script: 'latin', detect: true },
    { code: 'id', label: 'Indonesian / Malay', script: 'latin', detect: true },
    { code: 'tl', label: 'Filipino', script: 'latin', detect: true },
    { code: 'sw', label: 'Swahili', script: 'latin', detect: true },
    { code: 'el', label: 'Greek', script: 'native', detect: true },
    { code: 'he', label: 'Hebrew', script: 'native', detect: true },
    { code: 'pl', label: 'Polish', script: 'latin', detect: true },
    { code: 'ro', label: 'Romanian', script: 'latin', detect: true },
    { code: 'sv', label: 'Swedish', script: 'latin', detect: true },
    { code: 'da', label: 'Danish', script: 'latin', detect: true },
    { code: 'no', label: 'Norwegian', script: 'latin', detect: true },
    { code: 'fi', label: 'Finnish', script: 'latin', detect: true },
    { code: 'cs', label: 'Czech', script: 'latin', detect: true },
    { code: 'hu', label: 'Hungarian', script: 'latin', detect: true },
]);

export const LANGUAGE_CODES = Object.freeze(LANGUAGES.map((l) => l.code));

export const languageLabel = (code) => LANGUAGES.find((l) => l.code === code)?.label ?? code;

/** A language from what a customer typed: its code, its name ("gujarati", "Hindi"), or a number from a list. */
export function parseLanguage(text, offered = LANGUAGE_CODES) {
    const t = String(text ?? '').trim().toLowerCase().replace(/[.)\s]+$/, '');
    if (!t) return null;
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= offered.length) return offered[n - 1];
    const hit = LANGUAGES.find((l) => offered.includes(l.code)
        && (l.code === t || l.label.toLowerCase() === t || l.label.toLowerCase().split(/[ (/]/)[0] === t || NATIVE_NAMES[l.code]?.includes(t)));
    return hit?.code ?? null;
}

const NATIVE_NAMES = {
    hi: ['हिंदी', 'हिन्दी'], gu: ['ગુજરાતી'], mr: ['मराठी'], bn: ['বাংলা'], pa: ['ਪੰਜਾਬੀ'], ta: ['தமிழ்'],
    te: ['తెలుగు'], kn: ['ಕನ್ನಡ'], ml: ['മലയാളം'], or: ['ଓଡ଼ିଆ'], ur: ['اردو'], es: ['español', 'espanol'],
    fr: ['français', 'francais'], de: ['deutsch'], ar: ['العربية', 'عربي'],
};

// ------------------------------------------------------------- detection --
// Scripts with one language each, or a default for a shared one (refined below).
const SCRIPTS = [
    ['hi', /\p{Script=Devanagari}/u],
    ['gu', /\p{Script=Gujarati}/u],
    ['bn', /\p{Script=Bengali}/u],
    ['pa', /\p{Script=Gurmukhi}/u],
    ['or', /\p{Script=Oriya}/u],
    ['ta', /\p{Script=Tamil}/u],
    ['te', /\p{Script=Telugu}/u],
    ['kn', /\p{Script=Kannada}/u],
    ['ml', /\p{Script=Malayalam}/u],
    ['mni', /\p{Script=Meetei_Mayek}/u],
    ['sat', /\p{Script=Ol_Chiki}/u],
    ['ar', /\p{Script=Arabic}/u],
    ['he', /\p{Script=Hebrew}/u],
    ['el', /\p{Script=Greek}/u],
    ['ru', /\p{Script=Cyrillic}/u],
    ['th', /\p{Script=Thai}/u],
    ['ko', /\p{Script=Hangul}/u],
    ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
    ['zh', /\p{Script=Han}/u],
];

/** Inside a shared script: letters only one of its languages uses. */
const LETTERS = {
    hi: [['mr', /ळ/], ['ne', /(छ\b|छन्|हुनुहुन्छ)/]],
    bn: [['as', /[ৰৱ]/]],
    ar: [['ur', /[ٹڈڑںےھ]/], ['fa', /[پچژگ]/]],
    ru: [['uk', /[іїєґ]/]],
    // Kana makes Han Japanese; Han alone stays Chinese.
};

// Devanagari words that are Marathi or Nepali and not Hindi.
const SHARED_WORDS = {
    mr: ['आहे', 'आहेत', 'काय', 'नाही', 'मला', 'तुम्ही', 'कसे', 'किती', 'आणि', 'होते', 'पाहिजे', 'कुठे'],
    ne: ['छ', 'छन्', 'तपाईं', 'मलाई', 'कति', 'हुन्छ', 'गर्नुहोस्'],
};

// Common words of Latin-script languages (and of Hindi and Gujarati typed in English letters).
const MARKERS = {
    hinglish: 'hai hain kya kyu kyun kaise kaisa kaisi kitna kitne kitni nahi nahin nhi mujhe mera meri mere aap aapka aapke tum hum haan ji bhai bhaiya kab kaha kahan kidhar chahiye karna karo kariye bhi hoga hogi raha rahi tha thi accha acha theek thik bata batao bataiye abhi wala wali kuch yeh woh daam kimat keemat paisa paise aaj dhanyavad shukriya kripya',
    gujlish: 'kem cho chhe che su shu tame tamaro tamari mane maru mari kyare kya avse aavse thase joie joiye nathi hatu hase karo karjo kai saru majama aabhar bhai ben kevi kevu ketla ketlu ama aapo moklo',
    en: 'the is are was what when where how why you your please thanks thank hello hi can could would want need order price my me i we to of and for with this that have',
    es: 'hola como estas que el la los las de por favor gracias quiero necesito donde cuando buenos dias tienes usted es esta mi cuanto cuesta precio tienda envio puedo hay muchas tu su',
    fr: 'bonjour salut merci je vous tu est le la les des une un pour avec commande ou quand comment bien suis besoin',
    de: 'hallo guten morgen tag danke bitte ich sie du ist das der die und nicht mit fur meine bestellung wo wann wie',
    pt: 'ola oi obrigado obrigada voce eu nao sim por favor onde quando como esta meu minha bom dia tudo bem qual quanto custa preco loja fica chegou entrega frete horario funcionamento tem posso queria gostaria seu sua isso',
    it: 'ciao buongiorno grazie per favore io sono non il lo la gli che come dove quando ordine vorrei',
    nl: 'hallo goedemorgen dank je wel ik ben niet het een van mijn bestelling waar wanneer hoe graag',
    tr: 'merhaba tesekkurler lutfen ben sen bir ve bu ne nerede nasil siparis var yok evet hayir',
    id: 'halo terima kasih tolong saya anda kamu apa ini itu dan dengan pesanan dimana kapan bagaimana selamat pagi',
    tl: 'kumusta salamat po opo ako ikaw ang ng mga sa ito saan kailan paano gusto',
    sw: 'habari jambo asante tafadhali mimi wewe na ya kwa hii wapi lini vipi nataka',
    pl: 'dzien dobry czesc dziekuje prosze jestem nie jak gdzie kiedy moje zamowienie',
    ro: 'buna ziua multumesc va rog sunt nu si este unde cand cum comanda',
    sv: 'hej tack jag du inte och det ar var nar hur min bestallning',
    da: 'hej tak jeg du ikke og det er hvor hvornar hvordan min bestilling',
    no: 'hei takk jeg du ikke og det er hvor nar hvordan min bestilling',
    fi: 'hei kiitos mina sina ei ja on missa milloin miten tilaus huomenta',
    cs: 'ahoj dobry den dekuji prosim jsem ne a je kde kdy jak moje objednavka',
    hu: 'szia jo napot koszonom kerem vagyok nem es hol mikor hogyan rendeles',
    vi: 'xin chao cam on ban toi khong la co cua don hang o dau khi nao',
};
const MARKER_SETS = Object.fromEntries(Object.entries(MARKERS).map(([k, v]) => [k, new Set(v.split(' '))]));

// Letters that give a Latin-script language away.
const LATIN_LETTERS = [
    ['vi', /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđơư]/i],
    ['tr', /[ğışİ]/], ['pl', /[ąęłńśźż]/i], ['ro', /[ășț]/i], ['cs', /[ěřůčš]/i], ['hu', /[őű]/i],
    ['de', /ß/], ['es', /[ñ¿¡]/i], ['pt', /[ãõ]/i], ['da', /[æø]/i], ['sv', /ä.*å|å.*ä/i],
];

/**
 * { code, confidence, script } for a message. script: 'native' | 'roman' | 'latin' | null (nothing to read).
 * Low confidence (< 0.5) means "do not trust this alone".
 */
export function detect(text) {
    const raw = String(text ?? '');
    const letters = [...raw].filter((c) => /\p{L}/u.test(c));
    if (!letters.length) return { code: 'en', confidence: 0, script: null };

    const counts = new Map();
    for (const c of letters) {
        const hit = SCRIPTS.find(([, re]) => re.test(c));
        if (hit) counts.set(hit[0], (counts.get(hit[0]) ?? 0) + 1);
    }
    // Japanese mixes kana and Han: any kana makes it Japanese.
    if (counts.has('ja')) {
        counts.set('ja', counts.get('ja') + (counts.get('zh') ?? 0));
        counts.delete('zh');
    }
    const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    // Mixed text ("price कितना है") goes to the non-Latin script once it is a fair share of the letters.
    if (top && n / letters.length >= 0.3) {
        const words = raw.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{M}]/gu, ''));
        for (const [code, list] of Object.entries(SHARED_WORDS)) {
            if (top === 'hi' && words.some((w) => list.includes(w))) return { code, confidence: 0.8, script: 'native' };
        }
        const refined = (LETTERS[top] ?? []).find(([, re]) => re.test(raw))?.[0];
        return { code: refined ?? top, confidence: Math.min(1, 0.6 + n / 20), script: 'native' };
    }

    const lettered = LATIN_LETTERS.find(([, re]) => re.test(raw))?.[0];
    const words = raw.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
        .replace(/[^a-z\s]+/g, ' ').split(/\s+/).filter(Boolean);
    const scores = Object.entries(MARKER_SETS)
        .map(([code, set]) => [code, words.filter((w) => set.has(w)).length + (code === lettered ? 2 : 0)])
        .sort((a, b) => b[1] - a[1]);
    const [[best, hits], [, second = 0] = []] = scores;
    if (!hits) return { code: 'en', confidence: words.length >= 4 ? 0.4 : 0.2, script: 'latin' };
    // One telltale word in a two-word message is enough ("kem cho", "hola amigo"); a tie is a guess.
    const confidence = Math.min(1, (hits - second * 0.5) / Math.max(2, Math.min(words.length, 4)) + (lettered ? 0.3 : 0));
    const code = hits === second && best !== 'en' && scores.some(([c, h]) => c === 'en' && h === hits) ? 'en' : best;
    return { code, confidence: Math.max(0.1, Math.round(confidence * 100) / 100), script: code === 'hinglish' || code === 'gujlish' ? 'roman' : 'latin' };
}

/** The language code alone; 'en' for anything unreadable. */
export function detectLanguage(text) {
    return detect(text).code;
}
