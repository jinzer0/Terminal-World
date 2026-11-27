import stringWidth from 'string-width';
import type { ServiceTheme } from '../service/validation.js';
import type { PublicPersonalSpaceItem } from '../core/profile-service.js';

export type PublicSpaceId =
  | 'space:lobby'
  | 'space:focus'
  | 'space:cafe'
  | 'space:rooftop'
  | 'space:living'
  | 'space:oss';

export interface PublicSpaceDefinition {
  id: PublicSpaceId;
  shortLabel: string;
  title: string;
  subtitle: string;
  description: string;
}

export const PUBLIC_SPACES: readonly PublicSpaceDefinition[] = [
  {
    id: 'space:lobby',
    shortLabel: 'LOBBY',
    title: '로비',
    subtitle: '공지·접속자',
    description: '현재 접속자 현황과 공지사항을 확인하는 광장',
  },
  {
    id: 'space:focus',
    shortLabel: 'FOCUS',
    title: '집중실',
    subtitle: '집중·랭킹',
    description: '집중 타이머(HH:MM:SS)와 일별 공개 랭킹',
  },
  {
    id: 'space:cafe',
    shortLabel: 'CAFE',
    title: '카페',
    subtitle: '7게시판·모집',
    description: '7개 게시판 · 모집 필터 · 댓글',
  },
  {
    id: 'space:rooftop',
    shortLabel: 'ROOFTOP',
    title: 'RoofTop',
    subtitle: '실시간 채팅',
    description: '로그인 회원 실시간 채팅방 (14일 보관)',
  },
  {
    id: 'space:living',
    shortLabel: 'LIVING',
    title: 'Living Room',
    subtitle: '자리비움',
    description: '입장 시 해당 세션이 자리비움(AFK)으로 전환',
  },
  {
    id: 'space:oss',
    shortLabel: 'OSS',
    title: '오픈소스 탐색',
    subtitle: '이슈·저장소',
    description: '기여 이슈 탐색 및 공개 인기 저장소',
  },
];

export interface WorldSpaceNode {
  id: string;
  kind: 'public' | 'personal';
  label: string;
  title: string;
  subtitle: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  doorX: number;
  doorY: number;
  memberId?: string;
  nickname?: string;
  colorTheme?: ServiceTheme;
  gridSlot?: number;
}

export interface WorldMapModel {
  width: number;
  height: number;
  spaces: WorldSpaceNode[];
  blockedTiles: Set<string>;
  doors: Map<string, WorldSpaceNode>;
  defaultSpawn: { x: number; y: number };
}

export interface RemoteAvatar {
  sessionId: string;
  memberId: string | null;
  nickname: string;
  x: number;
  y: number;
  spaceId: string;
  away: boolean;
}

export interface CameraViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MoveResult {
  x: number;
  y: number;
  moved: boolean;
  blocked: boolean;
}

export interface AdjacentSpaceMatch {
  space: WorldSpaceNode;
  onDoor: boolean;
}

export interface WorldCounts {
  bySpaceId?: Record<string, string | number>;
}

const BUILDING_WIDTH = 16;
const BUILDING_HEIGHT = 4;
const COL_STRIDE = 20;
const START_X = 2;
const PUBLIC_Y = 1;
const PERSONAL_START_Y = 11;
const PERSONAL_ROW_STRIDE = 7;
const PERSONAL_COLS_PER_ROW = 6;

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function buildWorldMap(
  personalSpaces: readonly PublicPersonalSpaceItem[] = [],
): WorldMapModel {
  const spaces: WorldSpaceNode[] = [];
  const blockedTiles = new Set<string>();
  const doors = new Map<string, WorldSpaceNode>();

  const registerBuilding = (node: WorldSpaceNode) => {
    spaces.push(node);
    for (let by = node.y; by < node.y + node.height; by += 1) {
      for (let bx = node.x; bx < node.x + node.width; bx += 1) {
        blockedTiles.add(tileKey(bx, by));
      }
    }
    doors.set(tileKey(node.doorX, node.doorY), node);
  };

  PUBLIC_SPACES.forEach((pub, idx) => {
    const x = START_X + idx * COL_STRIDE;
    const y = PUBLIC_Y;
    registerBuilding({
      id: pub.id,
      kind: 'public',
      label: pub.shortLabel,
      title: pub.title,
      subtitle: pub.subtitle,
      description: pub.description,
      x,
      y,
      width: BUILDING_WIDTH,
      height: BUILDING_HEIGHT,
      doorX: x + 7,
      doorY: y + BUILDING_HEIGHT,
    });
  });

  let maxRow = 0;
  let maxCol = PUBLIC_SPACES.length - 1;
  for (const ps of personalSpaces) {
    const slot = Math.max(0, ps.gridSlot);
    const col = slot % PERSONAL_COLS_PER_ROW;
    const row = Math.floor(slot / PERSONAL_COLS_PER_ROW);
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);

    const x = START_X + col * COL_STRIDE;
    const y = PERSONAL_START_Y + row * PERSONAL_ROW_STRIDE;
    registerBuilding({
      id: ps.spaceId,
      kind: 'personal',
      label: `@${ps.nickname}`,
      title: `${ps.nickname}의 공간`,
      subtitle: `[${ps.colorTheme}]`,
      description: ps.currentStatus || ps.introduction || '개인 터미널 공간',
      x,
      y,
      width: BUILDING_WIDTH,
      height: BUILDING_HEIGHT,
      doorX: x + 7,
      doorY: y + BUILDING_HEIGHT,
      memberId: ps.memberId,
      nickname: ps.nickname,
      colorTheme: ps.colorTheme,
      gridSlot: slot,
    });
  }

  const width = Math.max(122, START_X + (maxCol + 1) * COL_STRIDE + 2);
  const height = Math.max(20, PERSONAL_START_Y + (maxRow + 1) * PERSONAL_ROW_STRIDE + 3);

  return {
    width,
    height,
    spaces,
    blockedTiles,
    doors,
    defaultSpawn: { x: START_X + 7, y: PUBLIC_Y + BUILDING_HEIGHT + 2 },
  };
}

export function isBlocked(map: WorldMapModel, x: number, y: number): boolean {
  if (x < 0 || x >= map.width || y < 0 || y >= map.height) {
    return true;
  }
  return map.blockedTiles.has(tileKey(x, y));
}

export function moveAvatar(
  map: WorldMapModel,
  pos: { x: number; y: number },
  dx: number,
  dy: number,
): MoveResult {
  const nextX = pos.x + dx;
  const nextY = pos.y + dy;
  if (isBlocked(map, nextX, nextY)) {
    return { x: pos.x, y: pos.y, moved: false, blocked: true };
  }
  return { x: nextX, y: nextY, moved: nextX !== pos.x || nextY !== pos.y, blocked: false };
}

export function getAdjacentSpace(
  map: WorldMapModel,
  x: number,
  y: number,
): AdjacentSpaceMatch | null {
  const doorMatch = map.doors.get(tileKey(x, y));
  if (doorMatch) {
    return { space: doorMatch, onDoor: true };
  }

  for (const space of map.spaces) {
    const withinX = x >= space.x && x < space.x + space.width;
    const withinY = y >= space.y && y < space.y + space.height;
    const distX = withinX ? 0 : x < space.x ? space.x - x : x - (space.x + space.width - 1);
    const distY = withinY ? 0 : y < space.y ? space.y - y : y - (space.y + space.height - 1);
    if (distX + distY === 1) {
      return { space, onDoor: false };
    }
  }

  return null;
}

/**
 * Computes camera viewport coordinates without zooming (always 1:1 tile scale).
 */
export function computeCameraViewport(
  map: WorldMapModel,
  playerPos: { x: number; y: number },
  viewportWidth: number,
  viewportHeight: number,
  prevCamera?: CameraViewport,
): CameraViewport {
  const vw = Math.max(10, viewportWidth);
  const vh = Math.max(6, viewportHeight);
  const maxX = Math.max(0, map.width - vw);
  const maxY = Math.max(0, map.height - vh);

  if (!prevCamera || prevCamera.width !== vw || prevCamera.height !== vh) {
    const cx = Math.max(0, Math.min(maxX, playerPos.x - Math.floor(vw / 2)));
    const cy = Math.max(0, Math.min(maxY, playerPos.y - Math.floor(vh / 2)));
    return { x: cx, y: cy, width: vw, height: vh };
  }

  const marginX = Math.min(12, Math.floor(vw * 0.25));
  const marginY = Math.min(5, Math.floor(vh * 0.25));

  let camX = prevCamera.x;
  let camY = prevCamera.y;

  if (playerPos.x < camX + marginX) {
    camX = playerPos.x - marginX;
  } else if (playerPos.x >= camX + vw - marginX) {
    camX = playerPos.x - (vw - marginX - 1);
  }

  if (playerPos.y < camY + marginY) {
    camY = playerPos.y - marginY;
  } else if (playerPos.y >= camY + vh - marginY) {
    camY = playerPos.y - (vh - marginY - 1);
  }

  return {
    x: Math.max(0, Math.min(maxX, camX)),
    y: Math.max(0, Math.min(maxY, camY)),
    width: vw,
    height: vh,
  };
}

function centerClip(text: string, innerCols: number): string {
  const clean = text.replace(/[\r\n\t]/g, '');
  const segs = Array.from(clean);
  let fitted = '';
  let w = 0;
  for (const ch of segs) {
    const cw = stringWidth(ch);
    if (w + cw > innerCols) break;
    fitted += ch;
    w += cw;
  }
  const leftPad = Math.floor((innerCols - w) / 2);
  const rightPad = innerCols - w - leftPad;
  return `${' '.repeat(Math.max(0, leftPad))}${fitted}${' '.repeat(Math.max(0, rightPad))}`;
}

function paintTextOnRow(
  cells: string[],
  startCol: number,
  text: string,
  maxCols: number,
): void {
  if (startCol >= maxCols) return;
  let col = startCol;
  for (const ch of text) {
    const cw = Math.max(1, stringWidth(ch));
    if (col < 0) {
      col += cw;
      continue;
    }
    if (col + cw > maxCols) break;
    // Clear any overwritten wide-char trailing marker
    if (cells[col] === '') {
      let prev = col - 1;
      while (prev >= 0 && cells[prev] === '') prev -= 1;
      if (prev >= 0) cells[prev] = ' ';
    }
    cells[col] = ch;
    for (let k = 1; k < cw; k += 1) {
      cells[col + k] = '';
    }
    col += cw;
  }
}

function rowCellsToString(cells: string[], maxCols: number): string {
  let out = '';
  let width = 0;
  for (let i = 0; i < cells.length && width < maxCols; i += 1) {
    const ch = cells[i]!;
    if (ch === '') continue;
    const cw = Math.max(1, stringWidth(ch));
    if (width + cw > maxCols) break;
    out += ch;
    width += cw;
  }
  if (width < maxCols) {
    out += ' '.repeat(maxCols - width);
  }
  return out;
}

export function renderWorldMapLines(
  map: WorldMapModel,
  params: {
    playerX: number;
    playerY: number;
    playerNickname: string;
    remoteAvatars?: readonly RemoteAvatar[];
    camera: CameraViewport;
    counts?: WorldCounts;
  },
): string[] {
  const { camera, playerX, playerY, playerNickname, remoteAvatars = [], counts } = params;
  const rows: string[][] = Array.from({ length: camera.height }, () =>
    Array.from({ length: camera.width }, () => ' '),
  );

  const paint = (worldX: number, worldY: number, text: string) => {
    const vy = worldY - camera.y;
    if (vy < 0 || vy >= camera.height) return;
    const vx = worldX - camera.x;
    paintTextOnRow(rows[vy]!, vx, text, camera.width);
  };

  // Walkway & district separator (non-blocking visual guides)
  const plazaY = PUBLIC_Y + BUILDING_HEIGHT + 1;
  for (let x = 0; x < map.width; x += 1) {
    if (x % 2 === 0) paint(x, plazaY, '·');
  }
  const dividerY = PERSONAL_START_Y - 2;
  for (let x = 2; x < map.width - 2; x += 2) {
    paint(x, dividerY, '─');
  }
  paint(Math.max(4, Math.floor(map.width / 2) - 10), dividerY, ' 개인 터미널 구역 ');

  // Draw buildings with 2.5D roof/wall + right/bottom depth shadow
  for (const space of map.spaces) {
    const inner = space.width - 2;
    const topBar = space.kind === 'public' ? `╔${'═'.repeat(inner)}╗` : `┌${'─'.repeat(inner)}┐`;
    const wall = space.kind === 'public' ? '║' : '│';
    const bottomLeft = space.kind === 'public' ? '╚' : '└';
    const bottomBar = space.kind === 'public' ? '═' : '─';
    const bottomRight = space.kind === 'public' ? '╝' : '┘';
    const doorPivot = space.kind === 'public' ? '╤' : '┬';

    const countOverride = counts?.bySpaceId?.[space.id];
    const line2Text = countOverride !== undefined ? String(countOverride) : space.subtitle;

    const leftWidth = 6;
    const rightWidth = inner - leftWidth - 1;
    const bottomRow = `${bottomLeft}${bottomBar.repeat(leftWidth)}${doorPivot}${bottomBar.repeat(rightWidth)}${bottomRight}`;

    paint(space.x, space.y, topBar);
    paint(space.x, space.y + 1, `${wall}${centerClip(space.label, inner)}${wall}░`);
    paint(space.x, space.y + 2, `${wall}${centerClip(line2Text, inner)}${wall}░`);
    paint(space.x, space.y + 3, `${bottomRow}░`);
    paint(space.doorX - 1, space.doorY, '[문]');
  }

  // Draw remote online avatars
  for (const avatar of remoteAvatars) {
    const badge = avatar.away || avatar.spaceId === 'space:living' ? ' [자리비움]' : '';
    const marker = `● @${avatar.nickname}${badge}`;
    paint(avatar.x, avatar.y, marker);
  }

  // Draw local player avatar on top
  paint(playerX, playerY, `★ @${playerNickname}`);

  return rows.map(row => rowCellsToString(row, camera.width));
}
