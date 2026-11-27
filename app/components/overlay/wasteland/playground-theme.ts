import { CHARACTER_ROWS, type CharacterRow, type CharacterState } from "../characters/view";

/**
 * The wasteland pictures of the character playground: atlas files, picture positions, frame timing, colours and
 * label style. Rules (positions, sizes of the world, durations of actions) come from the playground frames, so
 * another theme can replace this file alone. The atlas files are built by the tools described in docs/characters.md.
 */

/** A rectangle in an atlas: x, y, width, height in atlas pixels. */
export type Rect = readonly [number, number, number, number];
/** An offset in world px: x to the front of the character, y down. */
export type Point = readonly [number, number];

/** How a state animates: frame columns of one row, shown for `ticksPerFrame` ticks each. */
export interface Sequence {
  row: CharacterRow;
  frames: readonly number[];
  ticksPerFrame: number;
  /** After the last frame, continue from this index. Without it, the last frame stays. */
  loopFrom?: number;
  /** The column shown with reduced motion; the first frame when absent. */
  still?: number;
}

export interface PlaygroundTheme {
  courier: {
    url: string;
    cell: number;
    /** Left edge of each region; every region is `regionWidth` x `regionHeight`. */
    regions: { base: number; helmet: number; scarf: number };
    regionWidth: number;
    regionHeight: number;
    rows: readonly CharacterRow[];
    /** The cell pixel that sits on the character's feet position. */
    anchor: { x: number; y: number };
    /** Loose equipment, at the same place in every region (so the helmet gets the platform colour). */
    helmet: Rect;
    boot: Rect;
  };
  /** Helmet colour per platform id. */
  helmetColors: Readonly<Record<string, string>>;
  helmetFallback: string;
  scarfColor: string;
  sequences: Readonly<Record<CharacterState, Sequence | null>>;
  terrain: {
    url: string;
    tile: number;
    rects: Readonly<Record<TerrainPicture, Rect>>;
    /** Props on the middle runs of girders and of dirt, used in turn from left to right. */
    girderProps: readonly TerrainPicture[];
    dirtProps: readonly TerrainPicture[];
  };
  /** Offsets from a door centre and the ground. Each lamp (offset rect and colour) blinks while a character uses the door. */
  door: {
    dx: number;
    dy: number;
    entranceLamp: { rect: Rect; color: string };
    exitLamp: { rect: Rect; color: string };
  };
  flag: { dx: number; dy: number; ticksPerFrame: number };
  /** What the viewers build and carry. Offsets are from the feet of a character that faces right, in world px. */
  builds: {
    /** The rope is a drawn line. It starts at the gun while the character shoots, and at the hand on the ride. */
    rope: string;
    ropeInk: string;
    ropeFrom: { shoot: Point; zip: Point };
    /** The flame frames under the pack of a jetpack, by their top centre. */
    flame: { pictures: readonly TerrainPicture[]; at: Point };
    /** The bottom centre of the crown. */
    crown: Point;
    /**
     * The flags of the viewers: a strip of frames in the terrain atlas and the mask of their cloth, which gets the
     * platform colour. Each frame rectangle is in the strip, with the pole at its left edge.
     */
    viewerFlag: { strip: Rect; mask: Rect; frames: readonly Rect[]; ticksPerFrame: number };
  };
  joinSign: { dx: number; dy: number };
  exitSign: { dx: number; dy: number };
  antenna: { dx: number; dy: number };
  /** Offsets from the pad centre and the ground, idle and while a character respawns. */
  pad: { dx: number; dy: number; activeDx: number; activeDy: number };
  blinkMs: number;
  particles: {
    dust: readonly string[];
    soil: readonly string[];
    rocks: readonly TerrainPicture[];
    markInk: string;
    markRed: string;
  };
  label: {
    font: string;
    name: {
      size: number;
      fill: string;
      ink: string;
      outline: string;
      maxChars: number;
    };
    bubble: {
      size: number;
      fill: string;
      ink: string;
      maxWidth: number;
      maxLines: number;
    };
    badge: { fill: string; ink: string };
  };
}

export type TerrainPicture =
  | "antenna"
  | "crown"
  | "flame0"
  | "flame1"
  | "flame2"
  | "hook"
  | "plankL"
  | "plankM"
  | "plankR"
  | "stair"
  | "barrel"
  | "crack1"
  | "crack2"
  | "crate"
  | "dirt0"
  | "dirt1"
  | "dirt2"
  | "doorIn"
  | "doorOut"
  | "flag0"
  | "flag1"
  | "flag2"
  | "flag3"
  | "flag4"
  | "flag5"
  | "girderL"
  | "girderM"
  | "girderR"
  | "grass"
  | "hole"
  | "pad"
  | "padActive"
  | "railing"
  | "rock0"
  | "rock1"
  | "rock2"
  | "rocks"
  | "shrub"
  | "sign"
  | "signExit"
  | "signJoin";

/** Design pixels per world pixel. */
export const PIXEL_SCALE = 3;

const LOOP4 = [0, 1, 2, 3] as const;

export const WASTELAND_PLAYGROUND: PlaygroundTheme = {
  courier: {
    // The query is the first 8 hex digits of the SHA-256 of the file, so a new file is never served from cache.
    url: "/assets/overlay/wasteland-courier.png?v=bf88939a",
    cell: 32,
    regions: { base: 0, helmet: 128, scarf: 256 },
    regionWidth: 128,
    regionHeight: 624,
    rows: CHARACTER_ROWS,
    // The boots of every standing frame end on cell row 29; x 16 is the mirror axis.
    anchor: { x: 16, y: 30 },
    helmet: [0, 608, 8, 5],
    boot: [8, 608, 6, 5],
  },
  helmetColors: {
    youtube: "#E5322D",
    twitch: "#9146FF",
    kick: "#53FC18",
    instagram: "#B8794A",
  },
  helmetFallback: "#9E9E9E",
  scarfColor: "#105E6A",
  sequences: {
    enter: { row: "entrance", frames: LOOP4, ticksPerFrame: 5, loopFrom: 0, still: 3 },
    walk: { row: "walk", frames: LOOP4, ticksPerFrame: 4, loopFrom: 0 },
    goto: { row: "walk", frames: LOOP4, ticksPerFrame: 4, loopFrom: 0 },
    step: { row: "walk", frames: LOOP4, ticksPerFrame: 4, loopFrom: 0 },
    hold: { row: "idle", frames: LOOP4, ticksPerFrame: 5, loopFrom: 0 },
    // Reach, pull, cross the ledge, stand.
    climb: { row: "climb", frames: LOOP4, ticksPerFrame: 3 },
    // Hang, then pull and lift the knees until the top.
    zip: { row: "zip", frames: LOOP4, ticksPerFrame: 4, loopFrom: 1 },
    // Launch, then hover and lean in turn.
    jet: { row: "jet", frames: [0, 1, 2], ticksPerFrame: 4, loopFrom: 1 },
    // Hold, aim, fire. After a miss (16 ticks) the gun comes down.
    shoot: { row: "shoot", frames: [0, 1, 2, 2, 3], ticksPerFrame: 3 },
    dance: { row: "dance", frames: LOOP4, ticksPerFrame: 6, loopFrom: 0 },
    cheer: { row: "cheer", frames: LOOP4, ticksPerFrame: 6, loopFrom: 0 },
    push: { row: "push", frames: LOOP4, ticksPerFrame: 2 },
    turn: { row: "turn", frames: LOOP4, ticksPerFrame: 4 },
    idle: { row: "idle", frames: LOOP4, ticksPerFrame: 5, loopFrom: 0 },
    exit: { row: "exit", frames: LOOP4, ticksPerFrame: 5, loopFrom: 0 },
    // Crouch for 4 ticks, rise for 16, then fall.
    jump: { row: "jump", frames: [0, 1, 1, 1, 1, 2], ticksPerFrame: 4 },
    land: { row: "jump", frames: [3], ticksPerFrame: 1 },
    // Startle for 6 ticks, then tumble between frames 1 and 2 every 8 ticks.
    fall: {
      row: "fall",
      frames: [0, 0, 0, 1, 2, 2, 2, 2, 1, 1, 1, 1],
      ticksPerFrame: 2,
      loopFrom: 4,
    },
    flat: { row: "fall", frames: [3], ticksPerFrame: 1 },
    dig: { row: "dig", frames: LOOP4, ticksPerFrame: 5, loopFrom: 0 },
    build: { row: "build", frames: LOOP4, ticksPerFrame: 5, loopFrom: 0 },
    wave: { row: "wave", frames: LOOP4, ticksPerFrame: 6, loopFrom: 0 },
    // Stand for 24 ticks, then the dust poof.
    boom: { row: "explosion", frames: [0, 0, 0, 0, 1, 2, 3], ticksPerFrame: 6 },
    respawn: { row: "respawn", frames: LOOP4, ticksPerFrame: 8, loopFrom: 0, still: 3 },
    gone: null,
  },
  terrain: {
    url: "/assets/overlay/wasteland-terrain.png?v=526ce68a",
    tile: 16,
    rects: {
      antenna: [186, 59, 13, 22],
      crown: [3, 147, 10, 7],
      flame0: [21, 122, 6, 8],
      flame1: [37, 122, 6, 8],
      flame2: [53, 122, 6, 8],
      hook: [5, 133, 5, 5],
      plankL: [0, 106, 16, 6],
      plankM: [16, 106, 16, 6],
      plankR: [32, 106, 16, 6],
      stair: [48, 106, 16, 16],
      barrel: [116, 84, 12, 15],
      crack1: [200, 59, 16, 16],
      crack2: [217, 59, 16, 16],
      crate: [129, 84, 15, 12],
      dirt0: [234, 59, 16, 16],
      dirt1: [0, 84, 16, 16],
      dirt2: [17, 84, 16, 16],
      doorIn: [0, 0, 76, 58],
      doorOut: [77, 0, 76, 58],
      flag0: [181, 0, 26, 24],
      flag1: [208, 0, 26, 24],
      flag2: [0, 59, 26, 24],
      flag3: [27, 59, 26, 24],
      flag4: [54, 59, 26, 24],
      flag5: [81, 59, 26, 24],
      girderL: [34, 84, 16, 16],
      girderM: [51, 84, 16, 16],
      girderR: [68, 84, 16, 16],
      grass: [217, 84, 10, 6],
      hole: [85, 84, 16, 16],
      pad: [157, 84, 26, 9],
      padActive: [154, 0, 26, 26],
      railing: [184, 84, 32, 9],
      rock0: [243, 84, 5, 4],
      rock1: [249, 84, 4, 4],
      rock2: [8, 101, 3, 3],
      rocks: [228, 84, 14, 6],
      shrub: [145, 84, 11, 12],
      sign: [102, 84, 13, 16],
      signExit: [108, 59, 38, 24],
      signJoin: [147, 59, 38, 24],
    },
    girderProps: ["barrel", "railing"],
    dirtProps: ["grass", "sign", "rocks", "shrub", "crate"],
  },
  door: {
    dx: -38,
    dy: -58,
    entranceLamp: { rect: [1, -52, 5, 5], color: "#B8FFC8" },
    exitLamp: { rect: [-5, -52, 5, 5], color: "#FFF0B0" },
  },
  flag: { dx: -34, dy: -80, ticksPerFrame: 7 },
  builds: {
    rope: "#E7D7A8",
    ropeInk: "#1D1712",
    ropeFrom: { shoot: [10, -19], zip: [4, -28] },
    flame: { pictures: ["flame0", "flame1", "flame2"], at: [-10, -12] },
    crown: [0, -30],
    viewerFlag: {
      strip: [0, 154, 64, 16],
      mask: [64, 154, 64, 16],
      frames: [
        [3, 0, 10, 16],
        [19, 0, 10, 16],
        [35, 0, 10, 16],
        [51, 0, 10, 16],
      ],
      ticksPerFrame: 7,
    },
  },
  joinSign: { dx: 38, dy: -24 },
  exitSign: { dx: -76, dy: -24 },
  antenna: { dx: 10, dy: -54 },
  pad: { dx: -13, dy: -9, activeDx: -13, activeDy: -26 },
  blinkMs: 133,
  particles: {
    dust: ["#D8C39A", "#AE8C60"],
    soil: ["#7A5634", "#A06A38"],
    rocks: ["rock0", "rock1", "rock2"],
    markInk: "#1D1712",
    markRed: "#FF4A32",
  },
  label: {
    font: '"Segoe UI", Arial, sans-serif',
    name: {
      size: 18,
      fill: "rgba(29, 27, 24, 0.9)",
      ink: "#F3EAD3",
      outline: "rgba(0, 0, 0, 0.6)",
      maxChars: 20,
    },
    bubble: {
      size: 22,
      fill: "#F6ECD2",
      ink: "#1D1B18",
      maxWidth: 360,
      maxLines: 3,
    },
    badge: { fill: "rgba(29, 27, 24, 0.9)", ink: "#E5BD54" },
  },
};
