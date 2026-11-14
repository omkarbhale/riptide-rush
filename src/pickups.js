// Health recovery and modifier drops (#54). Pure logic: no DOM, no window, no timers.
// Every roll uses game.rng, so the same seed and inputs give the same drops (see test/pickups.test.js).
// game.js calls the hooks below at marked PICKUPS: points. Presentation reads game.pickups and
// game.modifiers and never writes back.
import {
  LOGICAL_WIDTH,
  LOGICAL_HEIGHT,
  PLAYER,
  DASH,
  COMBO,
  ARENA,
  PICKUP,
  MODIFIER,
} from './config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Modifier kinds, in the order a modifier drop picks them with game.rng.
export const MODIFIER_KINDS = ['sparkCoral', 'riptideCoal', 'shieldScale', 'frenzy', 'undertow'];

// Data table for presentation and HUD. Durations and effect numbers live in config.js (MODIFIER).
export const PICKUP_KINDS = {
  heal: { label: 'HEAL', color: '#5dff9b' },
  sparkCoral: { label: 'SPARK CORAL', color: '#3cf2ff' },
  riptideCoal: { label: 'RIPTIDE COAL', color: '#ffe066' },
  shieldScale: { label: 'SHIELD SCALE', color: '#ffffff' },
  frenzy: { label: 'FRENZY', color: '#ff3d81' },
  undertow: { label: 'UNDERTOW', color: '#b48cff' },
};

// Transient visuals kept in game.pickups.fx (rings and floaters). Capped so a long chain stays cheap.
const MAX_FX = 40;

export function createPickupState() {
  return {
    items: [],          // pickups on the field: { id, kind, x, y, vx, vy, age, r }
    lastDropAt: -Infinity,
    healPity: 0,        // hurt kills since the last heal drop
    modPity: 0,         // kills since the last modifier drop
    shieldGrace: 0,    // seconds of contact-damage grace left after a Shield Scale absorbs a hit
    hurts: 0,           // HP lost so far this run; a wave is flawless when this has not moved while it was live (#105)
    comboDue: false,    // a hurt player reached the combo trigger and the guaranteed heal orb is still owed (#105)
    comboOrbAt: -Infinity, // when the last combo heal orb dropped; the next may come after comboInterval (#105)
    fx: [],
  };
}

// ---- Effects of active modifiers (read by game.js) -----------------------------------------

export function hasModifier(game, kind) {
  return game.modifiers[kind] !== undefined;
}

// Max dash charges: 3, or 4 while Spark Coral is active.
export function dashMaxCharges(game) {
  return DASH.maxCharges + (hasModifier(game, 'sparkCoral') ? MODIFIER.sparkCoral.extraCharges : 0);
}

// Frenzy makes dash charges recharge 3x faster.
export function dashRechargeScale(game) {
  return hasModifier(game, 'frenzy') ? MODIFIER.frenzy.rechargeScale : 1;
}

// Frenzy adds 25% to dash distance.
export function dashDistanceScale(game) {
  return hasModifier(game, 'frenzy') ? 1 + MODIFIER.frenzy.dashDistanceBonus : 1;
}

// Riptide Coal drains the combo timer at half speed.
export function comboDrainScale(game) {
  return hasModifier(game, 'riptideCoal') ? MODIFIER.riptideCoal.comboDrainScale : 1;
}

// ---- Hooks called from game.js -------------------------------------------------------------

// Kill hook (after combo and score). Rolls at most one heal drop and one modifier drop per kill.
// Healing (#105) is earned two ways, and random orbs stay rare:
//  - a hurt player who reaches the combo trigger (20) is owed a heal orb, at most one per comboInterval.
//    The orb waits as "due" until it can drop (a free slot, the drop spacing), so a busy field cannot eat it.
//  - a random heal orb while hurt: a small chance per kill, with a pity count (#87).
export function onKill(game, e) {
  const s = game.pickups;
  const p = game.player;
  const hurt = p.hp < PLAYER.maxHp;

  if (hurt) {
    s.healPity += 1;
  } else {
    // Heal drops only happen while hurt, so the pity counter and any owed combo orb reset at full HP.
    s.healPity = 0;
    s.comboDue = false;
  }
  s.modPity += 1;

  if (hurt && game.combo.count >= PICKUP.heal.comboTrigger) s.comboDue = true;
  let healDropped = false;
  if (hurt && s.comboDue && game.time - s.comboOrbAt >= PICKUP.heal.comboInterval && canDrop(game)) {
    spawnPickup(game, 'heal', e.x, e.y, 'combo');
    s.comboOrbAt = game.time;
    s.comboDue = false;
    s.healPity = 0;
    healDropped = true;
  }
  if (hurt && !healDropped) {
    const guaranteed = s.healPity >= PICKUP.heal.pityKills;
    if ((guaranteed || game.rng() < healChance(game)) && canDrop(game)) {
      spawnPickup(game, 'heal', e.x, e.y, 'drop');
      s.healPity = 0;
    }
  }

  const guaranteedMod = s.modPity >= PICKUP.modifierPityKills;
  if ((guaranteedMod || game.rng() < PICKUP.modifierChance) && canDrop(game)) {
    const kind = MODIFIER_KINDS[Math.floor(game.rng() * MODIFIER_KINDS.length)];
    spawnPickup(game, kind, e.x, e.y);
    s.modPity = 0;
  }
}

// Heal chance per kill while hurt: 2% plus 2% per missing hit point.
export function healChance(game) {
  return PICKUP.heal.baseChance + PICKUP.heal.chancePerMissingHp * (PLAYER.maxHp - game.player.hp);
}

// Undertow: the enemies a shockwave from a kill at e reaches. Also records the ring visual.
// game.js kills each victim with killEnemy, so chains count for score and combo.
export function shockwaveVictims(game, e) {
  if (!hasModifier(game, 'undertow')) return [];
  const r = PICKUP.undertowRadius;
  pushFx(game, { kind: 'ring', x: e.x, y: e.y, r, life: 0.35, color: PICKUP_KINDS.undertow.color });
  const victims = [];
  for (const v of game.enemies) {
    if (v !== e && v.alive && Math.hypot(v.x - e.x, v.y - e.y) <= r) victims.push(v);
  }
  return victims;
}

// Per-step hook, called after the player has moved. `dashing` is true when the dash ran this step.
// Ages modifiers and pickups, pulls them in by magnet, and collects them by touch or by a dash path.
export function updatePickups(game, dt, dashing) {
  const s = game.pickups;
  const p = game.player;
  s.shieldGrace = Math.max(0, s.shieldGrace - dt);
  tickModifiers(game, dt);
  for (const f of s.fx) f.age += dt;
  s.fx = s.fx.filter((f) => f.age < f.life);

  const kept = [];
  for (const it of s.items) {
    it.age += dt;
    if (it.age >= PICKUP.lifetime) continue;

    // Pop: an outward kick from the drop point that decays.
    const decay = Math.exp(-PICKUP.popFriction * dt);
    it.vx *= decay;
    it.vy *= decay;
    it.x += it.vx * dt;
    it.y += it.vy * dt;

    // Magnet: inside the radius the pickup flies to the player.
    const dx = p.x - it.x;
    const dy = p.y - it.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= PICKUP.magnetRadius && dist > 1e-6) {
      const step = Math.min(dist, PICKUP.magnetSpeed * dt);
      it.x += (dx / dist) * step;
      it.y += (dy / dist) * step;
    }
    const [cx, cy] = clampToArena(it.x, it.y, it.r);
    it.x = cx;
    it.y = cy;

    // Collect: touching, or a dash path passing close enough.
    const touchR = PLAYER.radius + it.r;
    let hit = Math.hypot(p.x - it.x, p.y - it.y) <= touchR;
    if (!hit && dashing) {
      hit = segmentDistSq(p.px, p.py, p.x, p.y, it.x, it.y) <= PICKUP.dashCollectRadius * PICKUP.dashCollectRadius;
    }
    if (hit) collect(game, it);
    else kept.push(it);
  }
  s.items = kept;
}

// Shield hook, called when a hit would land. Returns true if a Shield Scale absorbed it: no HP lost,
// no hurt event, no normal invulnerability. A short bounce grace and a knockback stop a touching enemy
// from draining HP on the very next frame.
export function absorbHit(game, fromX, fromY) {
  if (!hasModifier(game, 'shieldScale')) return false;
  const p = game.player;
  endModifier(game, 'shieldScale');
  game.pickups.shieldGrace = PICKUP.shield.grace;
  const [dx, dy] = unit(p.x - fromX, p.y - fromY);
  const k = PLAYER.hitKnockback * PICKUP.shield.bounceKnockback;
  p.vx += dx * k;
  p.vy += dy * k;
  game.events.push({ type: 'shieldBreak', x: p.x, y: p.y });
  pushFx(game, { kind: 'ring', x: p.x, y: p.y, r: PLAYER.radius + 26, life: 0.4, color: PICKUP_KINDS.shieldScale.color });
  return true;
}

// Hurt hook, called after HP is lost. Counts the hit, so a wave can tell whether it was taken clean.
export function onHurt(game) {
  game.pickups.hurts += 1;
}

// Wave-clear hook, called when a wave clears. A release wave that cost no HP while it was live (since
// `rec.hurtsAt`, the hurt count when it began) heals 1 HP if Rip is hurt (#105). Other waves heal nothing:
// recovery is otherwise earned by chaining (the combo orb), and random orbs stay rare (#87).
export function onWaveEnd(game, rec) {
  if (!rec.release || game.pickups.hurts !== rec.hurtsAt) return;
  const p = game.player;
  if (p.hp >= PLAYER.maxHp) return;
  healPlayer(game, p.x, p.y, 'flawless');
}

// ---- Internals -----------------------------------------------------------------------------

// A drop needs 4 s since the previous drop and a free slot (at most 3 pickups on the field).
function canDrop(game) {
  return game.time - game.pickups.lastDropAt >= PICKUP.dropSpacing && game.pickups.items.length < PICKUP.maxOnField;
}

// origin says why a heal orb exists: 'drop' (random, rare) or 'combo' (the combo-trigger guarantee).
function spawnPickup(game, kind, x, y, origin = 'drop') {
  const s = game.pickups;
  const a = game.rng() * Math.PI * 2;
  const [cx, cy] = clampToArena(x, y, PICKUP.radius);
  const item = {
    id: game.nextId++,
    kind,
    origin,
    x: cx,
    y: cy,
    vx: Math.cos(a) * PICKUP.popSpeed,
    vy: Math.sin(a) * PICKUP.popSpeed,
    age: 0,
    r: PICKUP.radius,
  };
  s.items.push(item);
  s.lastDropAt = game.time;
  game.events.push({ type: 'pickupDrop', kind, x: cx, y: cy });
}

function collect(game, it) {
  game.events.push({ type: 'pickup', kind: it.kind, x: it.x, y: it.y });
  pushFx(game, { kind: 'ring', x: it.x, y: it.y, r: 28, life: 0.3, color: PICKUP_KINDS[it.kind].color });
  if (it.kind === 'heal') {
    healPlayer(game, it.x, it.y, it.origin ?? 'drop');
  } else {
    grantModifier(game, it.kind);
  }
}

// Restores HP. At full HP the heal converts to bonus score (base x multiplier), so it is never wasted.
export function healPlayer(game, x, y, source) {
  const p = game.player;
  let bonus = 0;
  if (p.hp < PLAYER.maxHp) {
    p.hp = Math.min(PLAYER.maxHp, p.hp + PICKUP.heal.restore);
    pushFx(game, { kind: 'text', x, y: y - 22, text: `+${PICKUP.heal.restore} HP`, color: PICKUP_KINDS.heal.color, life: 0.9 });
  } else {
    bonus = PICKUP.overflowScore * comboMultiplier(game.combo.count);
    game.score += bonus;
    pushFx(game, { kind: 'text', x, y: y - 22, text: `+${bonus}`, color: PICKUP_KINDS.heal.color, life: 0.9 });
  }
  game.events.push({ type: 'heal', x, y, source, hp: p.hp, bonus });
}

function grantModifier(game, kind) {
  // Stacking refreshes the timer; it never adds a second copy.
  game.modifiers[kind] = MODIFIER[kind].duration;
  if (kind === 'sparkCoral') {
    // Spark Coral also refills every charge, including the new fourth one.
    const d = game.player.dash;
    d.charges = dashMaxCharges(game);
    d.recharge = 0;
  }
}

function endModifier(game, kind) {
  delete game.modifiers[kind];
  if (kind === 'sparkCoral') {
    const d = game.player.dash;
    d.charges = Math.min(d.charges, DASH.maxCharges);
  }
  game.events.push({ type: 'modifierEnd', kind });
}

function tickModifiers(game, dt) {
  for (const kind of Object.keys(game.modifiers)) {
    game.modifiers[kind] -= dt;
    if (game.modifiers[kind] <= 0) endModifier(game, kind);
  }
}

function pushFx(game, fx) {
  const list = game.pickups.fx;
  list.push({ age: 0, ...fx });
  if (list.length > MAX_FX) list.splice(0, list.length - MAX_FX);
}

// Same formula as multiplierFor in game.js (kept here so this module does not import game.js).
function comboMultiplier(count) {
  return Math.min(COMBO.multiplierCap, 1 + Math.floor(count / COMBO.multiplierStep));
}

function clampToArena(x, y, r) {
  return [
    clamp(x, ARENA.inset + r, LOGICAL_WIDTH - ARENA.inset - r),
    clamp(y, ARENA.inset + r, LOGICAL_HEIGHT - ARENA.inset - r),
  ];
}

function unit(dx, dy) {
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? [dx / len, dy / len] : [0, 0];
}

// Squared distance from c to the segment a->b.
function segmentDistSq(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1) : 0;
  const px = ax + dx * t - cx;
  const py = ay + dy * t - cy;
  return px * px + py * py;
}
