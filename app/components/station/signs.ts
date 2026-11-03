import * as THREE from "three";
import type { Kit } from "./kit";
import { add, box, cyl, tube, plaque, rivets, TAU, DECK_Y } from "./shapes";
import { ringRadius } from "./mast";

export function buildSigns(k: Kit, station: THREE.Group): void {
  const { brass, gold, signCream, label } = k;
  const signFamily = (): string => k.family;
  function signFace(
    text: string,
    icon: "chat" | "poll" | "discuss",
  ): (ctx: CanvasRenderingContext2D, w: number, h: number) => void {
    return (ctx: CanvasRenderingContext2D, W: number, H: number): void => {
      const ink = "#1d4446";
      const bubble = (cx: number, cy: number, bw: number, bh: number, flip: boolean, fill: string): void => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, bh * 0.26);
        ctx.fill();
        const tx = flip ? cx + bw * 0.26 : cx - bw * 0.26;
        ctx.beginPath();
        ctx.moveTo(tx - 18, cy + bh / 2 - 2);
        ctx.lineTo(tx + (flip ? 26 : -26), cy + bh / 2 + 34);
        ctx.lineTo(tx + 22, cy + bh / 2 - 2);
        ctx.fill();
      };
      const cx = 170,
        cy = H / 2;
      if (icon === "chat") {
        bubble(cx, cy - 14, 220, 155, false, ink);
        ctx.fillStyle = "#e3d5b2";
        for (const dx of [-55, 0, 55]) {
          ctx.beginPath();
          ctx.arc(cx + dx, cy - 14, 16, 0, TAU);
          ctx.fill();
        }
      } else if (icon === "poll") {
        ctx.fillStyle = ink;
        [
          [-75, 70],
          [-8, 120],
          [58, 175],
        ].forEach(([dx, bh]: number[]): void => {
          ctx.beginPath();
          ctx.roundRect(cx + dx! - 26, cy + 88 - bh!, 52, bh!, 10);
          ctx.fill();
        });
      } else {
        bubble(cx + 32, cy - 38, 175, 120, true, "#5f7f74");
        bubble(cx - 28, cy + 22, 185, 125, false, ink);
      }
      ctx.fillStyle = ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = `800 ${Math.round(H * 0.31)}px ${signFamily()}`;
      text.split("\n").forEach((line: string, i: number): void => ctx.fillText(line, 330, H * (0.3 + i * 0.39), 660));
    };
  }
  const signs = add(new THREE.Group(), station);
  const mastWorld = (y: number): THREE.Vector3 => new THREE.Vector3(-0.7, DECK_Y + 3.98 + y * 1.12, -0.25);
  const boards: THREE.Group[] = [];
  for (const [text, icon, x, y, z, yaw, roll, joint] of [
    ["SUGGEST\nA TOPIC", "chat", -3.35, 7.2, 0.5, 0.22, -0.03, 2.2, 1],
    ["VOTE\nIN A POLL", "poll", -3.55, 5.6, 0.75, 0.2, 0.02, 1.25, 1],
    ["DISCUSS\nTHE STREAM", "discuss", 2.4, 6.6, 0.45, -0.22, 0.04, 1.75, -1],
  ] as const) {
    const board = add(new THREE.Group(), signs);
    board.position.set(x, y, z);
    board.rotation.set(0, yaw, roll);
    board.scale.setScalar(1.12);
    boards.push(board);
    plaque([2.36, 1.05, 0.12, 0.22], [0, 0, -0.1], gold, board);
    plaque([2.22, 0.92, 0.07, 0.18], [0, 0, 0.025], signCream, board);
    label(signFace(text, icon), [2.05, 0.82], [0, 0, 0.13], board, 0.12);
    rivets(
      [
        [-1.0, -0.35],
        [1.0, -0.35],
        [-1.0, 0.35],
        [1.0, 0.35],
      ].map(([bx, by]: number[]): THREE.Vector3 => new THREE.Vector3(bx!, by!, 0.135)),
      0.028,
      brass,
      board,
    );
    box([1.9, 0.06, 0.02], [0, -0.52, -0.04], gold, board, 0.01);
    // Back of the sign: aged enamel plate with a bolted brass mount where the arm enters.
    plaque([2.2, 0.9, 0.012, 0.18], [0, 0, -0.124], signCream, board);
    box([0.32, 0.32, 0.04], [0, 0, -0.14], gold, board, 0.02);
    rivets(
      [
        [-0.11, -0.11],
        [0.11, -0.11],
        [-0.11, 0.11],
        [0.11, 0.11],
      ].map(([bx, by]: number[]): THREE.Vector3 => new THREE.Vector3(bx!, by!, -0.165)),
      0.02,
      brass,
      board,
    );
    board.updateMatrixWorld();
    const centre = mastWorld(joint);
    const mount = new THREE.Vector3(0, 0, -0.16).applyMatrix4(board.matrix);
    const back = new THREE.Vector3(0, 0, -1).applyEuler(board.rotation);
    const out = new THREE.Vector3(mount.x - centre.x, 0, mount.z - centre.z).normalize();
    const start = centre.clone().add(out.clone().multiplyScalar(ringRadius(joint) * 1.12));
    tube(
      [
        start,
        start.clone().add(out.clone().multiplyScalar(0.35)),
        mount
          .clone()
          .add(back.clone().multiplyScalar(0.55))
          .setY((start.y + mount.y) / 2),
        mount.clone().add(back.clone().multiplyScalar(0.2)),
        mount,
      ],
      0.04,
      gold,
      signs,
      false,
      0.5,
    );
    cyl([0.065, 0.065, 0.1], [start.x, start.y, start.z], brass, signs, [12]);
  }
}
