import { ROAD_WIDTH, STREET_POSITIONS } from './world.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const angleTo = (a, b) => Math.atan2(a.x - b.x, a.z - b.z);
const angleDifference = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function closestStreet(value) {
  return STREET_POSITIONS.reduce((best, street) =>
    Math.abs(street - value) < Math.abs(best - value) ? street : best, STREET_POSITIONS[0]);
}

function adjacentIntersections(value) {
  const lower = [...STREET_POSITIONS].reverse().find(street => street <= value);
  const upper = STREET_POSITIONS.find(street => street >= value);
  return [...new Set([lower ?? STREET_POSITIONS[0], upper ?? STREET_POSITIONS.at(-1)])];
}

function roadOptions(position) {
  const x = closestStreet(position.x), z = closestStreet(position.z);
  const options = [];
  if (Math.abs(position.x - x) <= ROAD_WIDTH / 2 + 3) {
    for (const intersection of adjacentIntersections(position.z))
      options.push({ axis: 'z', point: { x, z: intersection } });
  }
  if (Math.abs(position.z - z) <= ROAD_WIDTH / 2 + 3) {
    for (const intersection of adjacentIntersections(position.x))
      options.push({ axis: 'x', point: { x: intersection, z } });
  }
  // Recovery remains possible if a player activates auto mode slightly off-road.
  if (!options.length) {
    const axis = Math.abs(position.x - x) < Math.abs(position.z - z) ? 'z' : 'x';
    for (const intersection of adjacentIntersections(axis === 'z' ? position.z : position.x))
      options.push({ axis, point: axis === 'z' ? { x, z: intersection } : { x: intersection, z } });
  }
  return options;
}

function coinRoad(coin) {
  const x = closestStreet(coin.x), z = closestStreet(coin.z);
  return Math.abs(coin.x - x) <= Math.abs(coin.z - z)
    ? { axis: 'z', street: x, endpoints: adjacentIntersections(coin.z) }
    : { axis: 'x', street: z, endpoints: adjacentIntersections(coin.x) };
}

function compact(points, position) {
  const result = [];
  let previous = position;
  for (const point of points) {
    if (distance(point, previous) > .75) { result.push(point); previous = point; }
  }
  return result;
}

function pathCost(position, heading, waypoints) {
  let cost = 0, previous = position, previousHeading = heading;
  for (const point of waypoints) {
    const length = distance(point, previous);
    if (length < .75) continue;
    const direction = angleTo(previous, point);
    const turn = Math.abs(angleDifference(direction, previousHeading));
    // Turns take time; an about-face is much worse than continuing forward.
    cost += length + turn * (cost === 0 ? 32 : 15);
    previousHeading = direction;
    previous = point;
  }
  return cost;
}

export function planCoinRoute(position, heading, coins) {
  const starts = roadOptions(position);
  let best = null;
  for (const coin of coins) {
    const road = coinRoad(coin);
    const candidates = [];
    // Following the same street directly avoids unnecessary trips via junctions.
    if (road.axis === 'z' && Math.abs(position.x - road.street) <= ROAD_WIDTH / 2)
      candidates.push([coin]);
    if (road.axis === 'x' && Math.abs(position.z - road.street) <= ROAD_WIDTH / 2)
      candidates.push([coin]);

    for (const start of starts) for (const endpoint of road.endpoints) {
      const exit = road.axis === 'z'
        ? { x: road.street, z: endpoint }
        : { x: endpoint, z: road.street };
      const entry = start.point;
      const middle = [
        { x: exit.x, z: entry.z },
        { x: entry.x, z: exit.z },
      ];
      for (const corner of middle) {
        // All intermediate segments run along streets, never diagonally through buildings.
        const aligned = road.axis === 'z'
          ? { x: coin.x, z: exit.z }
          : { x: exit.x, z: coin.z };
        candidates.push([entry, corner, exit, aligned, coin]);
      }
    }
    for (const candidate of candidates) {
      const points = compact(candidate, position);
      const cost = pathCost(position, heading, points);
      if (!best || cost < best.cost)
        best = { coin, x: coin.x, z: coin.z, waypoints: points, cost };
    }
  }
  return best;
}

/**
 * Route-following controller that uses the normal engine throttle, brakes and
 * steering. No teleportation, score injection or speed-limit bypass is needed.
 */
export function createCoinAutopilot() {
  let route = null;
  let index = 0;

  function reset() { route = null; index = 0; }

  function update(state, maxSpeedKmh, coins, traffic = []) {
    if (!coins.length || state.fuel <= 0) {
      return { up: false, down: false, left: false, right: false, handbrake: false, refuel: false, steering: 0, targetSpeed: 0 };
    }
    // Collected coins are respawned in-place by the game, so compare coordinates too.
    if (!route || !coins.includes(route.coin) || route.coin.x !== route.x || route.coin.z !== route.z) {
      route = planCoinRoute(state, state.heading, coins);
      index = 0;
    }
    if (!route) return { up: false, down: false, steering: 0, handbrake: false, refuel: false };

    const points = route.waypoints;
    const speed = Math.max(0, state.speed);
    while (index < points.length - 1 && distance(state, points[index]) < clamp(speed * .18, 4.5, 9))
      index++;

    const waypoint = points[index];
    const gap = distance(state, waypoint);
    const lookahead = clamp(speed * .4, 8, 18);
    let aim = waypoint;
    if (index < points.length - 1 && gap < lookahead) {
      const next = points[index + 1];
      const fraction = .35 * (1 - gap / lookahead);
      aim = { x: waypoint.x + (next.x - waypoint.x) * fraction,
        z: waypoint.z + (next.z - waypoint.z) * fraction };
    }

    const headingError = angleDifference(angleTo(state, aim), state.heading);
    // Proportional steering prevents the full-lock oscillation of binary keys.
    const steering = clamp(headingError * 2.0 - (state.steering || 0) * .24, -1, 1);
    let targetSpeed = maxSpeedKmh / 3.6;

    if (index < points.length - 1) {
      const next = points[index + 1];
      const incoming = angleTo(index ? points[index - 1] : state, waypoint);
      const outgoing = angleTo(waypoint, next);
      const bend = Math.abs(angleDifference(outgoing, incoming));
      if (bend > .25) {
        // Start slowing early enough to negotiate an intersection, then accelerate.
        const cornerSpeed = clamp(16 - bend * 5, 7, 15);
        const brakingDistance = Math.max(0, gap - 9);
        targetSpeed = Math.min(targetSpeed, Math.sqrt(cornerSpeed ** 2 + 2 * 25 * brakingDistance));
      }
    }

    // Hard steering at motorway speeds cannot make a tight turn on city roads.
    if (Math.abs(headingError) > .16)
      targetSpeed = Math.min(targetSpeed, clamp(30 / (1 + Math.abs(headingError) * 1.5), 6, 27));

    // Follow traffic with a distance buffer instead of colliding and bouncing.
    const forwardX = -Math.sin(state.heading), forwardZ = -Math.cos(state.heading);
    for (const npc of traffic) {
      const dx = npc.group.position.x - state.x;
      const dz = npc.group.position.z - state.z;
      const ahead = dx * forwardX + dz * forwardZ;
      const lateral = Math.abs(dx * forwardZ - dz * forwardX);
      if (ahead <= 0 || ahead >= 65 || lateral > 4.5) continue;
      const npcForwardSpeed = npc.axis === 'x'
        ? npc.direction * npc.speed * forwardX
        : npc.direction * npc.speed * forwardZ;
      targetSpeed = Math.min(targetSpeed,
        Math.max(0, npcForwardSpeed) + Math.max(0, ahead - 8) * 1.25);
    }

    return {
      up: speed < targetSpeed - .6,
      down: speed > targetSpeed + 1.1,
      left: steering > .04,
      right: steering < -.04,
      handbrake: false,
      refuel: false,
      steering,
      targetSpeed,
    };
  }

  return { update, reset };
}
