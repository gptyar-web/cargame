import test from 'node:test';
import assert from 'node:assert/strict';
import { planCoinRoute, createCoinAutopilot } from '../scripts/game/autopilot.js';

const driver = (overrides = {}) => ({
  x: 3.5, z: 54, heading: 0, speed: 0, steering: 0, fuel: 100, ...overrides,
});

test('auto-drive prioritizes the reachable coin directly ahead', () => {
  const nearby = { x: 3.5, z: 42 };
  const distant = { x: 111.5, z: 42 };
  const route = planCoinRoute(driver(), 0, [distant, nearby]);
  assert.equal(route.coin, nearby);
  assert.deepEqual(route.waypoints, [{ x: 3.5, z: 42 }]);
  const controls = createCoinAutopilot().update(driver(), 300, [nearby]);
  assert.equal(controls.up, true);
  assert.equal(controls.down, false);
  assert.ok(Math.abs(controls.steering) < .01);
});

test('routes to coins on other streets use safe junctions instead of cutting blocks', () => {
  const coin = { x: 111.5, z: 40 };
  const route = planCoinRoute(driver(), 0, [coin]);
  assert.equal(route.coin, coin);
  assert.deepEqual(route.waypoints.at(-1), coin);
  assert.ok(route.waypoints.some(p => p.x === 0 && (p.z === 0 || p.z === 108)),
    'the route reaches a street intersection');
  assert.ok(route.waypoints.some(p => p.x === 108),
    'the route joins the destination street');
});

test('autopilot steers toward a displaced coin and brakes for nearby traffic', () => {
  const pilot = createCoinAutopilot();
  const offsetCoin = { x: 8, z: 20 };
  const turn = pilot.update(driver({ speed: 6 }), 300, [offsetCoin]);
  assert.ok(turn.steering < 0);
  assert.equal(turn.right, true);

  pilot.reset();
  const coin = { x: 3.5, z: -100 };
  const car = { group: { position: { x: 3.5, z: 42 } }, axis: 'z', direction: -1, speed: 7 };
  const following = pilot.update(driver({ speed: 20 }), 300, [coin], [car]);
  assert.equal(following.down, true);
  assert.ok(following.targetSpeed < 20);
});

test('autopilot respects the selected car speed limit and does not drive without fuel', () => {
  const pilot = createCoinAutopilot();
  const coin = { x: 3.5, z: -100 };
  const drive = pilot.update(driver(), 100, [coin]);
  assert.ok(drive.targetSpeed <= 100 / 3.6);
  assert.equal(pilot.update(driver({ fuel: 0 }), 300, [coin]).up, false);
  assert.equal(pilot.update(driver(), 300, []).up, false);
});

test('autopilot anticipates corners instead of entering them at full speed', () => {
  const coin = { x: 111.5, z: 40 };
  const command = createCoinAutopilot().update(driver({ speed: 70 }), 300, [coin]);
  assert.equal(command.down, true);
  assert.ok(command.targetSpeed < 70);
});
