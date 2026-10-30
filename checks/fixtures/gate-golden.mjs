/**
 * The write-gate calibration golden set (40 items), shared by the Jev
 * calibration (checks/calibrate-jev-gate.mjs) and the decision-backend
 * challenger harness (checks/challenge-decisions.mjs) so every backend
 * is measured on exactly the same items. Extracted verbatim from the
 * original calibration script on 2026-10-30.
 */

export const EV = {
  receipt1: { id: 'ev-r1', text: 'Recall returns a receipt that cites the record id for every result.' },
  receipt2: { id: 'ev-r2', text: 'Every recall result carries a receipt that cites its own record id, so any answer can be traced to its source record.' },
  fusion1: { id: 'ev-f1', text: 'Hybrid recall fuses a keyword ranking with a vector ranking using reciprocal rank fusion.' },
  fusion2: { id: 'ev-f2', text: 'The fusion constant for hybrid recall is RRF k=60, chosen by the recall eval.' },
  dates1: { id: 'ev-d1', text: 'Memories carry valid from and valid to dates for time travel recall.' },
  dates2: { id: 'ev-d2', text: 'A superseded fact stays readable after a newer fact replaces it, because its valid to date is kept.' },
  pilot1: { id: 'ev-p1', text: 'The team goal for the quarter is a pilot with forty households.' },
  pilot2: { id: 'ev-p2', text: 'The pilot plan commits the team to forty households in the first quarter.' },
  lamp1: { id: 'ev-l1', text: 'The fictional product is a solar lamp kit assembled from flat packed parts.' },
  lamp2: { id: 'ev-l2', text: 'A volunteer reported that the lamp charged fully in six hours of sunlight.' },
  decay1: { id: 'ev-y1', text: 'Decay lowers the strength of memories that are never recalled.' },
  decay2: { id: 'ev-y2', text: 'Stale memories lose strength deterministically over time when nothing recalls them.' },
};

export const GATE_GOLDEN_ITEMS = [
  // ---- expected approve (12) ----
  { name: 'a01', expect: 'approve', proposal: { text: 'On Tuesday the field team tested the prototype in a community hall.', type: 'episodic' }, evidence: [] },
  { name: 'a02', expect: 'approve', proposal: { text: 'A storm delayed the second field visit by two days.', type: 'episodic' }, evidence: [] },
  { name: 'a03', expect: 'approve', proposal: { text: 'The demo laptop for the north site is stored in cabinet two.', type: 'semantic', scope: 'node_local' }, evidence: [] },
  { name: 'a04', expect: 'approve', proposal: { text: 'The workshop bench by the door holds the spare lamp casings.', type: 'semantic', scope: 'node_local' }, evidence: [] },
  { name: 'a05', expect: 'approve', proposal: { text: 'Recall returns a receipt that cites the record id for every result.', type: 'semantic', grounding_ids: ['ev-r1', 'ev-r2'] }, evidence: [EV.receipt1, EV.receipt2] },
  { name: 'a06', expect: 'approve', proposal: { text: 'Hybrid recall fuses a keyword ranking with a vector ranking using reciprocal rank fusion.', type: 'semantic', grounding_ids: ['ev-f1', 'ev-f2'] }, evidence: [EV.fusion1, EV.fusion2] },
  { name: 'a07', expect: 'approve', proposal: { text: 'Memories carry valid from and valid to dates for time travel recall.', type: 'semantic', grounding_ids: ['ev-d1', 'ev-d2'] }, evidence: [EV.dates1, EV.dates2] },
  { name: 'a08', expect: 'approve', proposal: { text: 'The team goal for the quarter is a pilot with forty households.', type: 'goals', grounding_ids: ['ev-p1', 'ev-p2'] }, evidence: [EV.pilot1, EV.pilot2] },
  { name: 'a09', expect: 'approve', proposal: { text: 'Decay lowers the strength of memories that are never recalled.', type: 'reflective', grounding_ids: ['ev-y1', 'ev-y2'] }, evidence: [EV.decay1, EV.decay2] },
  { name: 'a10', expect: 'approve', proposal: { text: 'A superseded fact stays readable after a newer fact replaces it.', type: 'semantic', grounding_ids: ['ev-d1', 'ev-d2'] }, evidence: [EV.dates1, EV.dates2] },
  { name: 'a11', expect: 'approve', proposal: { text: 'The first prototype failed its drop test and the casing was redesigned.', type: 'episodic', grounding_ids: [] }, evidence: [] },
  { name: 'a12', expect: 'approve', proposal: { text: 'The site whiteboard lists the two demo laptops and their cabinet.', type: 'working', scope: 'node_local' }, evidence: [] },
  // ---- expected escalate (20) ----
  { name: 'e01', expect: 'escalate', proposal: { text: 'To reset the demo device, hold the side button for five seconds.', type: 'procedural' }, evidence: [] },
  { name: 'e02', expect: 'escalate', proposal: { text: 'Reviewers decide queued proposals in arrival order.', type: 'procedural', grounding_ids: ['ev-r1', 'ev-r2'] }, evidence: [EV.receipt1, EV.receipt2] },
  { name: 'e03', expect: 'escalate', proposal: { text: 'Recall returns a receipt that cites the record id for every result.', type: 'semantic', pinned: true, grounding_ids: ['ev-r1', 'ev-r2'] }, evidence: [EV.receipt1, EV.receipt2] },
  { name: 'e04', expect: 'escalate', proposal: { text: 'Field notes are ingested as paragraph chunks of at most two thousand characters.', type: 'procedural', pinned: true }, evidence: [] },
  { name: 'e05', expect: 'escalate', proposal: { text: 'The moon base opens to visitors in 2027.', type: 'semantic' }, evidence: [] },
  { name: 'e06', expect: 'escalate', proposal: { text: 'Recall returns a receipt that cites the record id for every result.', type: 'semantic', grounding_ids: ['ev-r1'] }, evidence: [EV.receipt1] },
  { name: 'e07', expect: 'escalate', proposal: { text: 'Recall returns a receipt that cites the record id for every result.', type: 'semantic', grounding_ids: ['ev-l1', 'ev-l2'] }, evidence: [EV.lamp1, EV.lamp2] },
  { name: 'e08', expect: 'escalate', proposal: { text: 'Recall returns a receipt that cites the record id and the home address of the person who stored it.', type: 'semantic', grounding_ids: ['ev-r1', 'ev-r2'] }, evidence: [EV.receipt1, EV.receipt2] },
  { name: 'e09', expect: 'escalate', proposal: { text: 'The corpus never mentions pricing.', type: 'semantic', grounding_ids: ['ev-l1', 'ev-f1'] }, evidence: [EV.lamp1, EV.fusion1] },
  { name: 'e10', expect: 'escalate', proposal: { text: 'No other storage option exists for the demo kit.', type: 'semantic', grounding_ids: ['ev-l1', 'ev-l2'] }, evidence: [EV.lamp1, EV.lamp2] },
  { name: 'e11', expect: 'escalate', proposal: { text: 'Hybrid recall fuses a keyword ranking with a vector ranking using reciprocal rank fusion with constant k=30.', type: 'semantic', grounding_ids: ['ev-f1', 'ev-f2'] }, evidence: [EV.fusion1, EV.fusion2] },
  { name: 'e12', expect: 'escalate', proposal: { text: 'The team goal for the quarter is a pilot with forty households.', type: 'goals' }, evidence: [] },
  { name: 'e13', expect: 'escalate', proposal: { text: 'Decay lowers the strength of memories that are never recalled.', type: 'reflective', grounding_ids: ['ev-y1'] }, evidence: [EV.decay1] },
  { name: 'e14', expect: 'escalate', proposal: { text: 'Recall returns a receipt that cites the record id for every result.', type: 'semantic', grounding_ids: ['ev-ghost1', 'ev-ghost2'] }, evidence: [] },
  { name: 'e15', expect: 'escalate', proposal: { text: 'The current demo script opens with the lamp assembly story.', type: 'working' }, evidence: [] },
  { name: 'e16', expect: 'escalate', proposal: { text: 'The fusion constant for hybrid recall is RRF k=45.', type: 'semantic', grounding_ids: ['ev-f1', 'ev-f2'] }, evidence: [EV.fusion1, EV.fusion2] },
  { name: 'e17', expect: 'escalate', proposal: { text: 'Every memory in the store is pinned.', type: 'semantic', grounding_ids: ['ev-d1', 'ev-d2'] }, evidence: [EV.dates1, EV.dates2] },
  { name: 'e18', expect: 'escalate', proposal: { text: 'The pilot will definitely succeed and expand to ten thousand households next quarter.', type: 'goals', grounding_ids: ['ev-p1', 'ev-p2'] }, evidence: [EV.pilot1, EV.pilot2] },
  { name: 'e19', expect: 'escalate', proposal: { text: 'A superseded fact is deleted permanently when a newer fact replaces it.', type: 'semantic', grounding_ids: ['ev-d1', 'ev-d2'] }, evidence: [EV.dates1, EV.dates2] },
  { name: 'e20', expect: 'escalate', proposal: { text: 'The lamp charges fully in one hour of sunlight.', type: 'semantic', grounding_ids: ['ev-l1', 'ev-l2'] }, evidence: [EV.lamp1, EV.lamp2] },
  // ---- expected reject (8) ----
  { name: 'r01', expect: 'reject', proposal: { text: 'asdf qwer zxcv jkl; poiuy', type: 'semantic' }, evidence: [] },
  { name: 'r02', expect: 'reject', proposal: { text: '!!! ### $$$ %%% ^^^ &&&', type: 'semantic' }, evidence: [] },
  { name: 'r03', expect: 'reject', proposal: { text: 'blah blah blah blah blah', type: 'semantic' }, evidence: [] },
  { name: 'r04', expect: 'reject', proposal: { text: 'lorem ipsum dolor sit amet consectetur adipiscing elit', type: 'semantic' }, evidence: [] },
  { name: 'r05', expect: 'reject', proposal: { text: 'stuff', type: 'semantic' }, evidence: [] },
  { name: 'r06', expect: 'reject', proposal: { text: 'test test test test test test', type: 'semantic' }, evidence: [] },
  { name: 'r07', expect: 'reject', proposal: { text: 'qwertyuiop asdfghjkl zxcvbnm', type: 'semantic' }, evidence: [] },
  { name: 'r08', expect: 'reject', proposal: { text: '...', type: 'semantic' }, evidence: [] },
];
