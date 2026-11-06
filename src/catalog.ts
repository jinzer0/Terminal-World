export const LIMITS = Object.freeze({ nickname: 16, nicknameCells: 24, introduction: 160, status: 40, chat: 400, guestbook: 200, fileBytes: 16 * 1024 * 1024, messages: 10_000, guestbooks: 10_000 });
export const SPACES = Object.freeze({ 'space:lobby': '로비', 'space:rooftop': 'RoofTop' });
export const LOCAL_USER_ID = 'user:local';
export const LOCAL_TERMINAL_ID = 'terminal:local';
export const ASCII_PRESETS = Object.freeze({
  'ascii:cat': Object.freeze({ label: '고양이', art: ' /\\_/\\\n( o.o )\n > ^ <' }),
  'ascii:mountain': Object.freeze({ label: '산', art: '    /\\\n /\\/  \\/\\\n/        \\' }),
  'ascii:plant': Object.freeze({ label: '새싹', art: '  \\ | /\n   \\|/\n  [___]' }),
  'ascii:planet': Object.freeze({ label: '행성', art: "   .---.\n--(  o  )--\n   '---'" }),
});
export type AsciiPresetId = keyof typeof ASCII_PRESETS;
export const THEMES = Object.freeze({
  'theme:slate': Object.freeze({ background: '#111827', text: '#E5E7EB', muted: '#94A3B8', accent: '#38BDF8', border: '#334155' }),
  'theme:violet': Object.freeze({ background: '#1E1B2E', text: '#EDE9FE', muted: '#B8AED6', accent: '#C4B5FD', border: '#4C4067' }),
  'theme:teal': Object.freeze({ background: '#102A2A', text: '#D9F3EE', muted: '#93BBB3', accent: '#5EEAD4', border: '#28534E' }),
});
export type ThemeId = keyof typeof THEMES;
export const PALETTE = Object.freeze({ background: '#0F172A', panel: '#111827', text: '#E5E7EB', muted: '#94A3B8', border: '#334155', selected: '#1E293B', accent: '#38BDF8', success: '#34D399', error: '#F87171' });
export const EXAMPLE_USERS = Object.freeze([
  Object.freeze({ id: 'example:mina', terminalId: 'terminal:example:mina', nickname: 'Mina', introduction: '작은 화면에 취향을 모읍니다.', status: '별을 보는 중', asciiPresetId: 'ascii:cat', themeId: 'theme:violet' }),
  Object.freeze({ id: 'example:jun', terminalId: 'terminal:example:jun', nickname: 'Jun', introduction: '천천히 한 줄씩 만듭니다.', status: '산책 생각 중', asciiPresetId: 'ascii:mountain', themeId: 'theme:slate' }),
  Object.freeze({ id: 'example:sol', terminalId: 'terminal:example:sol', nickname: 'Sol', introduction: '초록빛 작은 공간입니다.', status: '쉬어 가세요', asciiPresetId: 'ascii:plant', themeId: 'theme:teal' }),
] as const);
export type ExampleTerminalId = (typeof EXAMPLE_USERS)[number]['terminalId'];
export const SEED_CHAT_MESSAGES = Object.freeze([
  Object.freeze({ id: 'seed:rooftop:welcome', origin: 'example', authorId: 'example:mina', roomId: 'space:rooftop', text: 'RoofTop에 오신 것을 환영해요.' }),
  Object.freeze({ id: 'seed:rooftop:local-only', origin: 'example', authorId: 'example:jun', roomId: 'space:rooftop', text: '이곳의 새 메시지는 내 기기에만 저장돼요.' }),
] as const);
export const DEFAULT_PROFILE = Object.freeze({ introduction: '나만의 작은 터미널입니다.', status: '둘러보는 중', asciiPresetId: 'ascii:cat', themeId: 'theme:slate' } as const);
