/**
 * The free first look at a visitor's message, in code with no AI call (plan §7.1 step 2,
 * docs/phase-5-chat-plan.md). It raises four flags:
 *
 * - disguised: text hidden so the rules can't read it. That's Base64 (an encoding that turns any
 *   text into a run of letters and digits), hex (the same with only 0-9 and a-f), reversed text,
 *   ROT13 (every letter swapped for the one 13 places along the alphabet), and leetspeak (digits
 *   standing in for letters, as in "h3llo"). A strike, since the only reason to hide a question
 *   is to get it past the rules.
 * - nonEnglish: the chat answers in English only, so this gets the English-only reply, no strike.
 * - links and gibberish: hints for the strike check, which makes the call.
 *
 * A wrong "disguised" is a strike against a real recruiter, so every rule here is deliberately
 * narrow: it looks for the thing itself (a 24-character run that decodes to readable text, a
 * message that only makes sense backwards), never for something merely unusual like "k8s",
 * "OAuth 2.0", "GPT-4" or "C#". When in doubt, a rule doesn't fire; the strike check still reads
 * the message.
 */
import { findUrls } from "./clean.ts";
import type { PrefilterFlags } from "./types.ts";

const words = (list: string) => new Set(list.trim().split(/\s+/));

// ── Word lists ──────────────────────────────────────────────────────────────────────────────────

/**
 * Common English, as a recruiter or an attacker would write it, plus the technical words of this
 * site. Used to tell English from reversed, ROT13 or leetspeak text, and to leave real words alone
 * as gibberish. It doesn't have to be complete: a word missing only makes a rule fire less often.
 */
const ENGLISH = words(`
  the a an and or but nor so yet for of in on at by to from with without within about above across after against along
  among around before behind below beneath beside between beyond during except inside into near off onto out outside over
  past since through throughout toward under until up upon via while per than as like unlike despite
  i me my mine myself you your yours yourself he him his himself she her hers herself it its itself we us our ours they
  them their theirs themselves one ones someone anyone everyone nobody somebody anybody everybody something anything
  everything nothing this that these those here there where when why how what which who whom whose whatever whenever
  however is am are was were be been being do does did done doing have has had having can could will would shall should
  may might must not no yes ok okay sure maybe perhaps please thanks thank hello hi hey bye goodbye sorry welcome all any
  both each either neither every few many more most much none other another such own same several some enough very too
  quite rather really actually just only even still already yet again ever never always often sometimes usually soon now
  then today tomorrow yesterday tonight later early late if because although though unless whether once twice
  what's it's that's there's here's let's who's how's where's he's she's they're we're you're i'm i've i'll i'd you've
  you'll you'd we've we'll they've they'll don't doesn't didn't can't couldn't won't wouldn't shouldn't isn't aren't
  wasn't weren't haven't hasn't hadn't mustn't ain't o'clock
  go goes went gone going come comes came coming get gets got getting make makes made making take takes took taken taking
  give gives gave given giving know knows knew known knowing think thinks thought thinking say says said saying tell
  tells told telling ask asks asked asking want wants wanted wanting need needs needed needing use uses used using try
  tries tried trying let leave leaves left leaving put puts keep keeps kept see sees saw seen seeing look looks looked
  looking find finds found finding work works worked working call calls called calling help helps helped helping start
  starts started starting stop stops stopped stopping run runs ran running show shows showed shown showing turn turns
  turned play plays played playing move moves moved live lives lived living believe bring brought happen happens happened
  write writes wrote written writing read reads reading provide provides sit stand lose pay paid meet met include includes
  included continue set sets learn learns learned learning change changes changed lead leads led understand understood
  watch follow follows followed create creates created speak spoke spoken allow add added spend spent grow grew open opens
  opened walk win won offer offers remember love loves loved consider appear buy bought wait serve die send sent expect
  build builds built stay fall cut reach kill remain suggest raise pass sell require report decide pull explain hope
  develop develops developed carry break receive agree support hit produce eat cover catch draw choose cause point listen
  realize place close involve share join prefer enjoy handle manage ship shipped fix fixed solve solved review reviewed
  improve improved explore apply applied applying interview interviewed hire hired hiring mean means meant seem seems
  feel feels felt sound sounds ready wonder
  time year years people way day days man thing things woman life child world school state family student group country
  problem hand part place case week weeks company system program question questions number night point home water room
  mother area money story fact month months lot right study book eye job word words business issue side kind head house
  service friend father power hour hours game line end member law car city community name team minute minutes idea kid
  body information back parent face others level office door health person art war history party result morning reason
  research moment air teacher force education example order course matter plan part reply answer answers message messages
  chat conversation question topic detail details thing sense hand lot bit sort type side
  good new first last long great little old big high different small large next young important few public bad able best
  better worse sure free real full special easy clear recent hard major whole human possible strong low true certain nice
  happy short main simple available likely personal social local private international general final current particular
  various common top similar necessary wrong fine fast slow quick quickly simply exactly specific specifically
  experience experiences role roles position positions candidate resume career careers salary compensation benefits remote
  onsite hybrid relocate relocation visa sponsorship authorization authorized citizen citizenship availability notice
  degree masters master bachelors bachelor university college graduate graduated graduation gpa major minor skills skill
  strengths strength weakness weaknesses project projects portfolio github linkedin email phone contact address reference
  references recruiter recruiting manager engineer engineers engineering developer developers development software
  hardware data science scientist analyst analytics intern internship contract contractor freelance employer employee
  employment employed hours schedule start date offer offers hiring process salary range rate pay paid interviewing
  python javascript typescript java rust golang ruby swift kotlin scala php sql nosql html css react angular vue svelte
  node nodejs express django flask fastapi spring docker kubernetes terraform aws azure gcp cloud server servers client
  backend frontend fullstack stack api apis rest graphql grpc database databases postgres postgresql mysql sqlite mongodb
  redis kafka spark airflow pandas numpy sklearn tensorflow pytorch keras model models machine learning deep neural network
  networks training inference embedding embeddings vector vectors retrieval rag llm llms gpt claude openai anthropic prompt
  prompts agent agents pipeline pipelines deploy deployed deployment test tests testing code coding programming app apps
  application applications web website mobile ios android linux windows mac macos git commit branch merge request devops
  security auth oauth token tokens password passwords encryption cache queue async thread threads performance latency
  scale scaling scalable architecture design pattern patterns framework frameworks library libraries tool tools tooling
  language languages algorithm algorithms structure function functions class classes object objects type types error
  errors bug bugs debug debugging log logs monitor monitoring metrics dashboard ml ai nlp vision speech voice audio video
  image images text file files folder script scripts shell terminal command commands bash config configuration
  environment production staging open source search index indexing query queries scripts strings string prompts
  ignore ignored ignoring previous prior above earlier instructions instruction rules rule secret secrets hidden
  confidential mode jailbreak override bypass disregard forget pretend roleplay act acting character persona unrestricted
  restrictions restriction filter filters safety guidelines policy policies repeat print output translate summarize
  decode encode base reverse backwards respond response essay poem joke song free chatbot assistant bot chatgpt simulate
  imagine hypothetical scenario instead following below reveal show system developer admin sudo root
  january february march april june july august september october november december monday tuesday wednesday thursday
  friday saturday sunday morning afternoon evening week weekend
  tall dark light red green blue black white cold hot warm cool dry wet sweet sour happy sad angry hungry tired busy
  money cash price cost costs cheap expensive buy sell bought sold shop store market food dog cat bird fish horse
  mountain river sea ocean tree flower sun moon star sky rain snow wind fire earth stone paper pen table chair bed
  window wall floor road street bridge train plane boat ship bus bike
`);

/**
 * English words that settle that a message is English: ones none of the other languages checked
 * below also use ("a", "no", "me", "in", "was" are in several, so they say nothing).
 */
const ENGLISH_EVIDENCE = words(`
  the and but are were been being you your yours yourself he she they them their we our us it its this that these those
  what which who whom how when where why can could would should have has had does did done will shall might must with
  without from about into over under after before between through during if because although though not any some many
  much more most very just also only even still hello hi hey thanks thank please sorry okay what's it's that's i'm i've
  i'll don't doesn't didn't can't won't isn't aren't you're we're they're let's
  tell ask want need know think work use help find give take make get go come see look
`);

/** Common words of languages that are written in Latin letters but aren't English. */
const FOREIGN = words(`
  de la le en il di el los las un una unos unas del y pero porque qué quien quién cual cuál cuales cuáles cuando cuándo donde dónde como cómo
  cuanto cuánto cuántos cuántas por para con sin sobre entre hasta desde hacia según durante es soy eres somos están
  estoy estás está estamos ser estar fue hay he tengo tienes tiene tenemos tienen tener hacer hago haces hace puedo puedes
  puede podemos pueden poder quiero quieres quiere quieren querer voy vas vamos van ir decir dice dime dices veo sé sabes
  sabe saber te se nos os mi mis tu tus su sus nuestro nuestra este esta esto estos estas ese esa eso muy mas más menos
  mucho mucha muchos poco tanto también tampoco siempre nunca ahora hoy mañana ayer aquí allí ya todavía solo sólo sí hola
  buenos buenas días tardes noches gracias favor adiós saludos trabajo trabajar experiencia empresa años año tiempo
  proyecto proyectos sueldo salario cuéntame háblame hablas habla hablar español inglés conoces ti ustedes usted vosotros
  ellos ellas nosotros yo tú él ella
  le les des du et ou mais donc toutes tous toute tout précédentes précédent révèle système dis dites parlez votre
   car ni que qui quoi dont où ce cet cette ces ça cela ceci est sont suis es sommes êtes été
  être étais avoir ai as avons avez ont avais fait faire fais faites font peux peut peuvent pouvez pouvoir veux veut
  voulez vouloir vais vas allez vont aller dit dire dis sais sait savez savoir je tu il elle nous vous ils elles
  lui leur leurs moi toi eux mon ma mes ton ta tes sa ses notre nos votre vos ne pas plus jamais rien très trop bien mal
  aussi encore déjà toujours maintenant demain hier ici là avec sans pour par sur sous dans chez vers depuis pendant
  selon contre bonjour bonsoir salut merci plaît plait travail travailler expérience entreprise ans temps projet projets
  salaire parlez parle parler français anglais comment pourquoi quand combien quel quelle quels quelles
  der die das den dem des ein eine einen einem einer eines und oder aber denn sondern weil dass ob wenn als wie was wer
  wen wem wessen wo wohin woher wann warum wieso weshalb welche welcher welches welchen ist sind bin bist seid war waren
  gewesen sein hat haben habe hast habt hatte hatten kann kannst können könnt könnten muss musst müssen soll sollen willst
  wollen wollt möchte möchten werden wird wirst wurde wurden geworden mache machen machst macht gibt geben sagen sagt
  sehen sieht ich du er sie es wir ihr mich dich ihn euch ihnen mir dir ihm mein meine meinen meinem meiner dein deine
  deinen unser unsere euer ihre ihren ihrem ihrer seine nicht kein keine keinen keinem auch noch schon nur sehr mehr immer
  nie nun jetzt heute morgen gestern hier dort da mit von zu für auf aus bei nach vor über unter durch gegen ohne um bis
  seit zum zur im am vom beim ins hallo guten tag abend danke bitte erfahrung jahre jahren jahr arbeit arbeiten
  unternehmen firma projekt gehalt sprechen sprichst spricht deutsch englisch
  os um uma uns umas do da dos das em na nos nas ao aos à às pelo pela pelos pelas sem até ou porque quê quem qual quais
  quando onde quanto quantos quantas é são sou és somos estou está estão estamos foi era há tenho tem tens temos têm ter
  fazer faço faz fazem posso pode podes podem poder quero quer queres querem querer vou vai vais vão dizer diz digo ver
  vejo sei sabes eu vós eles elas você vocês lhe lhes meu minha meus minhas teu tua seu seus suas nosso nossa isto esse
  essa isso aquele muita muitos mais tão também sempre nunca agora hoje amanhã ontem aqui ali já ainda só sim não olá bom
  boa dia tarde noite obrigado obrigada adeus experiência empresa anos tempo projeto salário falar fala falas português
  inglês
  lo gli dell dello della dei degli delle di nel nello nella nei nelle sul sulla ed ma però perché che chi cosa cui come
  dove quando quanto quanti quale quali è sono sei siamo siete ero essere stato ho hai ha abbiamo avete hanno avere faccio
  fai fa facciamo fanno puoi può possiamo possono potere voglio vuoi vuole vogliamo vogliono volere vorrei vado vai
  andiamo vanno andare dico dici dice vedere vedo so sai sa sapere io lui lei noi voi loro ti ci vi mio mia miei mie tuo
  tua tuoi tue suo sua suoi sue nostro nostra vostro questo questa questi queste quello quella più meno molto molta molti
  poco anche mai ora adesso oggi domani ieri qui qua lì già ancora solo sì ciao salve buongiorno buonasera grazie prego
  scusa lavoro lavorare esperienza azienda anni anno tempo progetto stipendio parlare parli parla italiano inglese
  het een en of maar want dat dit deze dan als toen omdat dus ook nog al wel niet geen nooit altijd soms vaak veel weinig
  meer minder zeer erg heel te van op aan bij met voor naar uit over door om tot tegen tussen onder boven zonder tijdens
  zijn ben bent waren geweest worden wordt werd heb hebt heeft hebben hadden kan kun kunt kunnen moet moeten zal zult
  zullen wil wilt willen mag mogen doe doet doen gaat gaan ga ging komt kom komen zeg zegt zeggen zie ziet zien weet weten
  ik jij je hij zij ze wij jullie mij jou hem haar ons hun mijn jouw uw onze wat wie waar wanneer waarom hoe welke welk
  hallo goedemorgen goedemiddag goedenavond dank bedankt alsjeblieft alstublieft ervaring jaar jaren werk werken bedrijf
  salaris spreken spreek spreekt nederlands engels
`);
// A word that's English as well isn't evidence of another language.
for (const word of FOREIGN) if (ENGLISH.has(word) || ENGLISH_EVIDENCE.has(word)) FOREIGN.delete(word);

// ── Text helpers ────────────────────────────────────────────────────────────────────────────────

/** Lowercase words, with apostrophes kept inside them ("what's"). */
const englishWords = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z]+(?:'[a-z]+)*/g) ?? [];

const isWord = (token: string) => ENGLISH.has(token);

// ── Disguised text ──────────────────────────────────────────────────────────────────────────────
//
// Text only counts as disguised when it decodes to readable text. A run that merely has the shape
// of an encoding (a 40-character commit hash, a pasted API key, a long ID) is no evidence that
// anyone hid anything, and a wrong "disguised" is a strike, so it becomes a hint in the reasons.

/** Whether a piece of text reads as text: nearly all letters, digits, spaces and punctuation, with real letters in it. */
function readableText(text: string): boolean {
  const chars = [...text.replaceAll("\0", "")];
  if (chars.length < 4) return false;
  let letters = 0;
  let plain = 0;
  for (const char of chars) {
    if (/\p{L}/u.test(char)) {
      letters++;
      plain++;
    } else if (/[\t\n\r ]|[\p{N}\p{P}\p{S}]/u.test(char)) plain++;
  }
  return letters >= 4 && plain / chars.length >= 0.9 && letters / chars.length >= 0.4;
}

/** Whether bytes (from hex, binary, Base64 or escapes) are UTF-8 text. A hash or a key isn't. */
function readableBytes(bytes: Uint8Array): boolean {
  try {
    // Zero bytes are dropped first: text in UTF-16 has one between every two letters.
    return readableText(new TextDecoder("utf-8", { fatal: true }).decode(bytes.filter((byte) => byte !== 0)));
  } catch {
    return false;
  }
}

const hexBytes = (digits: string) => Buffer.from(digits.slice(0, digits.length - (digits.length % 2)), "hex");

/** A token between spaces with the punctuation around it taken off, keeping Base64's "=" padding. */
const bare = (token: string) => token.replace(/^[^A-Za-z0-9+/]+/, "").replace(/[^A-Za-z0-9+/=]+$/, "");

/**
 * A run of 24 or more Base64 letters, with the mix of capitals and lowercase that data has: "text"
 * if it decodes to readable text, "blob" if it doesn't but is long enough to look like a key. A long
 * word, a CamelCase name or a file path isn't Base64 at all.
 */
function base64(token: string): "text" | "blob" | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return null;
  const body = token.replace(/=+$/, "");
  if (body.length < 24 || !/[a-z]/.test(body) || !/[A-Z]/.test(body)) return null;
  const slashes = body.split("/").length - 1;
  if (slashes >= 3 && slashes * 12 > body.length) return null;
  // A CamelCase name never has a capital letter that isn't followed by a lowercase one; random data does.
  if (/^[A-Za-z0-9]+$/.test(body) && !/[A-Z](?![a-z])/.test(body)) return null;
  const bytes = Buffer.from(body, "base64");
  if (bytes.length >= 16 && readableBytes(bytes)) return "text";
  return body.length >= 40 && /[0-9+/=]/.test(token) ? "blob" : null;
}

/** At least a dozen single letters in a row, spaced or dotted apart: "i g n o r e   a l l ...". */
const SPACED_LETTERS = /(?<![A-Za-z0-9])[A-Za-z](?:[ .\-_*,|]{1,3}[A-Za-z]){11,}(?![A-Za-z0-9])/g;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** The share of a string of letters that reads as English words run together ("ignoreallprevious"). */
function wordShare(letters: string): number {
  const covered = new Array<number>(letters.length + 1).fill(0);
  for (let end = 1; end <= letters.length; end++) {
    covered[end] = covered[end - 1];
    for (let size = 1; size <= Math.min(14, end); size++) {
      const word = letters.slice(end - size, end);
      if (size === 1 && word !== "a" && word !== "i") continue;
      if (ENGLISH.has(word)) covered[end] = Math.max(covered[end], covered[end - size] + size);
    }
  }
  return covered[letters.length] / letters.length;
}

/** What looks like an encoding in the text: the kinds that decode to readable text, and the ones that only have the look. */
function encoded(text: string): { disguised: string[]; hints: string[] } {
  const disguised = new Set<string>();
  const hints = new Set<string>();
  /** Records a find as disguise if it decoded to text, else as a hint. */
  const found = (kind: string, readable: boolean) => (readable ? disguised.add(kind) : hints.add(kind));

  const spaced = text.split(/\s+/).filter(Boolean);
  for (const token of spaced.map(bare).filter(Boolean)) {
    const kind = base64(token);
    if (kind) found("base64 blob", kind === "text");
    const hex = /^(?:0x)?([0-9a-f]{32,})$/i.exec(token)?.[1];
    if (hex && /[a-f]/i.test(hex)) found("hex blob", readableBytes(hexBytes(hex)));
  }

  for (const run of text.match(/(?:\\x[0-9a-f]{2}){4,}/gi) ?? []) found("escaped characters", readableBytes(hexBytes(run.replace(/\\x/gi, ""))));
  for (const run of text.match(/(?:%[0-9a-f]{2}){8,}/gi) ?? []) found("escaped characters", readableBytes(hexBytes(run.replace(/%/g, ""))));
  for (const run of text.match(/(?:\\u[0-9a-f]{4}){4,}/gi) ?? []) {
    found("escaped characters", readableText(run.replace(/\\u([0-9a-f]{4})/gi, (_all, code: string) => String.fromCharCode(parseInt(code, 16)))));
  }

  // Hex bytes written out one by one, as in "49 67 6e 6f 72 65".
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 12 && run.filter((t) => /[a-f]/i.test(t)).length >= 3) found("hex bytes", readableBytes(hexBytes(run.map((t) => t.replace(/^0x/i, "")).join(""))));
    run = [];
  };
  for (const token of spaced.map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ""))) {
    if (/^(?:0x)?[0-9a-f]{2}$/i.test(token)) run.push(token);
    else flush();
  }
  flush();

  // Binary: "01001001 01100111 ...".
  for (const group of text.matchAll(/(?:^|\s)((?:[01]{8}(?:\s+|$)){4,})/g)) {
    found("binary digits", readableBytes(Uint8Array.from([...group[1].matchAll(/[01]{8}/g)].map((byte) => parseInt(byte[0], 2)))));
  }

  for (const spacedOut of text.matchAll(SPACED_LETTERS)) {
    const letters = spacedOut[0].replace(/[^A-Za-z]/g, "").toLowerCase();
    // Reciting the alphabet is harmless.
    if (ALPHABET.includes(letters) || [...ALPHABET].reverse().join("").includes(letters)) continue;
    found("spaced-out letters", wordShare(letters) >= 0.85);
  }

  // Invisible "tag" characters can spell out hidden text; they appear legitimately only in a few flag emoji.
  const tags = text.match(/[\u{E0020}-\u{E007E}]/gu) ?? [];
  if (tags.length >= 4 && !text.includes("\u{1F3F4}")) found("hidden characters", readableText(tags.map((t) => String.fromCharCode(t.codePointAt(0)! - 0xe0000)).join("")));

  // A kind that decoded to text somewhere isn't also a hint.
  return { disguised: [...disguised], hints: [...hints].filter((kind) => !disguised.has(kind)) };
}

/** Whether the message makes far more sense with its letters reversed, or shifted 13 places (ROT13). */
function scrambled(text: string): string[] {
  const reasons: string[] = [];
  const forward = englishWords(text).filter((w) => w.length >= 3);
  if (forward.length < 3) return reasons;
  const known = forward.filter(isWord).length;
  const reversed = englishWords([...text].reverse().join("")).filter((w) => w.length >= 3);
  const rotated = forward.map((w) => w.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97)));
  const other = (candidates: string[]) => {
    const hits = candidates.filter(isWord).length;
    return hits >= 3 && hits >= 3 * known && hits / candidates.length >= 0.5;
  };
  if (other(reversed)) reasons.push("reversed text");
  if (other(rotated)) reasons.push("ROT13 text");
  return reasons;
}

const LEET: Record<string, string[]> = { "0": ["o"], "1": ["i", "l"], "3": ["e"], "4": ["a"], "5": ["s"], "7": ["t"], "8": ["b"], "9": ["g"], "@": ["a"], $: ["s"], "!": ["i"], "+": ["t"] };

/** Whether swapping a word's digits and symbols for letters ("1gn0r3" to "ignore") gives a real word. */
function leetWord(token: string): boolean {
  if (!/^[a-z0-9@$!+]+$/.test(token) || !/[a-z]/.test(token) || !/[0-9@$!+]/.test(token) || ENGLISH.has(token)) return false;
  let options = [""];
  for (const char of token) {
    const swaps = LEET[char] ?? (/[a-z]/.test(char) ? [char] : null);
    // A digit with no letter it stands for (2, 6) means this isn't leetspeak, probably a product name.
    if (!swaps) return false;
    options = options.flatMap((o) => swaps.map((s) => o + s));
    if (options.length > 16) return false;
  }
  return options.some((o) => o.length >= 3 && ENGLISH.has(o));
}

/** Heavy leetspeak: at least three words, and at least 30% of the words, that are real words in disguise. */
function leetspeak(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9@$!+]+/, "").replace(/[^a-z0-9@$]+$/, ""))
    .filter((t) => /[a-z]/.test(t));
  const disguised = tokens.filter(leetWord).length;
  return disguised >= 3 && disguised / tokens.length >= 0.3;
}

// ── Other languages ─────────────────────────────────────────────────────────────────────────────

/** The text with its web addresses taken out, so a path or a domain isn't read as words. */
function withoutLinks(text: string): string {
  let prose = text;
  for (const link of [...findUrls(text)].reverse()) prose = `${prose.slice(0, link.start)} ${prose.slice(link.end)}`;
  return prose;
}

/** A reason if the message is mostly not English, or nothing. */
function foreign(text: string): string | null {
  let latin = 0;
  let other = 0;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    if (/\p{Script=Latin}/u.test(char)) latin++;
    else other++;
  }
  if (other >= 2 && other > latin) return "mostly non-Latin letters";

  const tokens = text.toLowerCase().replace(/[’‘]/g, "'").match(/\p{L}+(?:'\p{L}+)*/gu) ?? [];
  if (tokens.length < 2) return null;
  let strange = 0;
  let english = 0;
  for (const token of tokens) {
    if (ENGLISH_EVIDENCE.has(token)) english++;
    else if (FOREIGN.has(token) || token.split("'").some((part) => part.length >= 2 && FOREIGN.has(part))) strange++;
  }
  // Several other-language function words, and next to no English ones. A longer message can have
  // English words in it that aren't function words (a tool name, "instructions"), so it needs fewer.
  const share = strange / tokens.length;
  const enough = share >= 0.4 || (strange >= 3 && share >= 0.25);
  return strange >= 2 && enough && english <= 1 && english * 2 < strange ? "words of another language" : null;
}

// ── Gibberish ───────────────────────────────────────────────────────────────────────────────────

/** Runs of keys along a keyboard row, both ways: "asdfg", and the vowel-free "asdf". */
const MASHING = (() => {
  const found = new Set<string>();
  for (const row of ["qwertyuiop", "asdfghjkl", "zxcvbnm"]) {
    for (const line of [row, [...row].reverse().join("")]) {
      for (let i = 0; i + 5 <= line.length; i++) found.add(line.slice(i, i + 5));
      for (let i = 0; i + 4 <= line.length; i++) if (!/[aeiou]/.test(line.slice(i, i + 4))) found.add(line.slice(i, i + 4));
    }
  }
  // The row starts that contain a vowel, and aren't inside any English word.
  for (const m of ["asdf", "fdsa", "qwer", "rewq", "uiop", "poiu"]) found.add(m);
  return [...found];
})();
/** Real words that sit on the keyboard. */
const KEYBOARD_WORDS = new Set(["qwerty", "qwertz", "azerty", "dvorak", "colemak"]);

/** Why the message looks like random typing, or nothing. */
function gibberish(text: string): string[] {
  const reasons: string[] = [];
  // Links have their own flag; don't read their paths as words.
  const prose = withoutLinks(text);

  const chunks = (prose.match(/[A-Za-z]+/g) ?? []).flatMap((t) => t.replace(/([a-z])([A-Z])/g, "$1 $2").split(" "));
  let mashing = false;
  let consonants = false;
  let noVowels = false;
  for (const chunk of chunks) {
    const lower = chunk.toLowerCase();
    if (!KEYBOARD_WORDS.has(lower) && MASHING.some((m) => lower.includes(m))) mashing = true;
    const shouting = chunk.length > 1 && chunk === chunk.toUpperCase();
    if (shouting || ENGLISH.has(lower)) continue;
    if (/[^aeiouy]{6,}/.test(lower)) consonants = true;
    const vowels = (lower.match(/[aeiouy]/g) ?? []).length;
    if (lower.length >= 6 && vowels === 0) noVowels = true;
    if (lower.length >= 10 && vowels / lower.length < 0.15) noVowels = true;
  }
  if (mashing) reasons.push("keyboard mashing");
  if (consonants) reasons.push("long run of consonants");
  if (noVowels) reasons.push("long word with almost no vowels");
  // "Sooooooo good!!!!!" is friendly: only a dozen or more of a letter, or twenty of a symbol, counts.
  if (/([A-Za-z0-9])\1{11,}|([^\sA-Za-z0-9])\2{19,}/.test(text)) reasons.push("one character repeated");
  const solid = text.replace(/\s/g, "");
  if (solid.length >= 12 && (solid.match(/[!-/:-@[-`{-~]/g)?.length ?? 0) / solid.length > 0.6) reasons.push("mostly symbols");
  return reasons;
}

// ── The pre-filter ──────────────────────────────────────────────────────────────────────────────

/**
 * @param message what the visitor typed (not the job posting, which is information only)
 */
export function prefilter(message: string): PrefilterFlags {
  // Full-width and styled letters ("ｉｇｎｏｒｅ") become ordinary ones before anything is checked.
  const text = message.normalize("NFKC");

  const encodings = encoded(text);
  const disguises = [...encodings.disguised, ...scrambled(text), ...(leetspeak(text) ? ["leetspeak"] : [])];
  const language = foreign(withoutLinks(text));
  const links = findUrls(text).map((link) => link.url);
  const mashing = gibberish(text);

  return {
    disguised: disguises.length > 0,
    nonEnglish: language !== null,
    links,
    gibberish: mashing.length > 0,
    reasons: [
      ...disguises.map((r) => `disguised: ${r}`),
      // The shape of an encoding without any text in it: not a strike, but the strike check may want to know.
      ...encodings.hints.map((r) => `hint: ${r}, not readable text`),
      ...(language ? [`non-English: ${language}`] : []),
      ...(links.length ? [`links: ${links.length}`] : []),
      ...mashing.map((r) => `gibberish: ${r}`),
    ],
  };
}
