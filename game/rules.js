// Every Drop Counts — all the numbers live here.
// Every value is a starting value to be tuned with `npm run sim`.
// Shared by the server, the tests and the browser (loaded as window.EDRules).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const START = {
    dam: 4,            // units stored in the dam at the start
    damCap: 10,        // dam capacity
    raisedDamCap: 15,  // capacity after "Raise the dam"
    health: 70,        // river health out of 100
    fund: 0,
    points: 0,
    loss: 1,           // units lost between each pair of regions
  };

  const HEALTH = {
    max: 100,
    envMin: 4,         // environmental minimum sea flow
    mildFloor: 2,      // sea flow 2..3 is a mild fall
    up: 4,
    mildDown: -5,
    badDown: -16,
    healthy: 60,
    crisis: 25,
    bonusRate: 0.3,
    bonusMax: 30,
  };

  // Okabe–Ito colour-blind-safe palette; every region also has a name and an icon.
  const REGIONS = {
    highlands: {
      id: 'highlands', name: 'Highlands', icon: '⛰️', color: '#CC79A7', kind: 'dam',
      role: 'Dam and hydro power',
      turbineCap: 18,            // units that can pass through the turbines (1 point each)
      defaultKeep: 4,
      howScore: '1 point for each unit released through the turbines (up to 18). Water above that spills and scores nothing. Water you store is there for dry seasons.',
      simple: 'You run the dam. Release water to make power (1 point a unit), or store it for later.',
    },
    orchard: {
      id: 'orchard', name: 'Orchard Plains', icon: '🍎', color: '#009E73', kind: 'take',
      role: 'Farms', farm: true, max: 6, yield: [4, 4, 4, 2, 2, 2], defaultAmount: 4,
      howScore: 'Units 1–3 score 4 points each, units 4–6 score 2 points each.',
      simple: 'Your farms need water. The first 3 units are worth the most.',
    },
    springs: {
      id: 'springs', name: 'Mountain Springs', icon: '💧', color: '#F0E442', kind: 'take',
      role: 'Tributary valley', farm: true, max: 3, yield: [4, 4, 3], adds: 6, defaultAmount: 2,
      howScore: 'Your creek adds 6 units to the river. You can take up to 3: 4, 4 and 3 points.',
      simple: 'Your creek adds 6 units to the river. You can take up to 3.',
    },
    cotton: {
      id: 'cotton', name: 'Cotton Flats', icon: '🌾', color: '#E69F00', kind: 'take',
      role: 'Large irrigation', farm: true, max: 10, yield: [4, 4, 3, 3, 2, 2, 2, 2, 1, 1], defaultAmount: 7,
      howScore: 'Units 1–2 score 4 each, 3–4 score 3 each, 5–8 score 2 each, 9–10 score 1 each.',
      simple: 'You grow cotton, which needs lots of water. The first 4 units are worth the most.',
    },
    town: {
      id: 'town', name: 'River Town', icon: '🏙️', color: '#D55E00', kind: 'take',
      role: 'City', town: true, max: 5, yield: [6, 6, 6, 2, 2], essential: 3, essentialRecycling: 2,
      shortfallPenalty: 5, defaultAmount: 3,
      howScore: 'Units 1–3 score 6 each (essential), units 4–5 score 2 each. Every unit below 3 costs you 5 points.',
      simple: 'Your town needs 3 units for drinking water. Each unit you miss costs 5 points.',
    },
    delta: {
      id: 'delta', name: 'Delta and Wetlands', icon: '🦩', color: '#0072B2', kind: 'sea',
      role: 'Estuary', perUnit: 3, perUnitWetland: 4, maxUnits: 6, minBonus: 6,
      howScore: '3 points per unit reaching the sea (up to 6 units), plus 6 points if at least 4 units arrive (the environmental minimum).',
      simple: 'You take no water. You score when water reaches the sea: at least 4 units gives a bonus.',
    },
  };

  // River order, upstream to downstream. The first region receives the rain.
  const LAYOUTS = {
    4: ['highlands', 'orchard', 'cotton', 'town', 'delta'], // Highlands run by the computer
    5: ['highlands', 'orchard', 'cotton', 'town', 'delta'],
    6: ['highlands', 'orchard', 'springs', 'cotton', 'town', 'delta'],
  };

  const CLIMATES = {
    wet:    { id: 'wet', name: 'Wet', icon: '🌧️', inflow: 36, weight: 20, text: 'A wet season: plenty of water is expected.' },
    normal: { id: 'normal', name: 'Normal', icon: '🌤️', inflow: 26, weight: 45, text: 'An ordinary season.' },
    dry:    { id: 'dry', name: 'Dry', icon: '☀️', inflow: 16, weight: 25, text: 'A dry season: there will not be enough for everyone to take the maximum.' },
    severe: { id: 'severe', name: 'Severe dry', icon: '🏜️', inflow: 8, weight: 10, text: 'A severe dry: very little water. Stored water in the dam matters now.' },
  };

  const HAZARDS = {
    drought: {
      id: 'drought', name: 'Drought', icon: '🥵', inflowMult: 0.6, nextSeason: true, farmLoss: 4,
      response: { name: 'Drought relief', cost: 8 },
      text: 'Inflow falls to 60% this season and next. Without drought relief, each farm team loses 4 points.',
      simple: 'Much less rain this season and next. Farms lose 4 points unless the fund pays for drought relief.',
      advanced: 'Drought is a hydrological hazard: preparing a shared fund is cheaper than recovering afterwards.',
      teaching: 'Hazards need a response, and preparation is cheaper.',
    },
    flood: {
      id: 'flood', name: 'Flood', icon: '🌊', inflowMult: 1.5, damage: 6,
      response: { name: 'Emergency response', cost: 10 },
      text: 'Inflow rises by half and the dam spills. Every team below the dam loses 6 points in damage unless it has a levee, or the fund pays for an emergency response.',
      simple: 'Huge rain! Every team below the dam loses 6 points unless it has a levee or the fund pays for help.',
      advanced: 'Floods show why community and government responses are planned before the event.',
      teaching: 'Community and government response.',
    },
    bushfire: {
      id: 'bushfire', name: 'Bushfire', icon: '🔥', inflowCut: 4, townExtra: 1,
      response: { name: 'Replanting', cost: 6 },
      text: 'Burnt catchment: next season has 4 fewer units of water, and River Town needs 1 extra unit to treat its water. Replanting cancels both.',
      simple: 'A fire burns the hills. Next season has less water and the town needs more, unless the fund pays for replanting.',
      advanced: 'Some hazards have delayed effects on the catchment.',
      teaching: 'Hazards can have delayed effects.',
    },
    heatwave: {
      id: 'heatwave', name: 'Heatwave', icon: '🌡️', loss: 2,
      text: 'Very hot weather: the river loses 2 units between each region this season instead of 1.',
      simple: 'Very hot! More water dries up between each region.',
      advanced: 'Evaporation is a cost nobody controls.',
      teaching: 'Evaporation is a cost nobody controls.',
    },
    algal: {
      id: 'algal', name: 'Algal bloom', icon: '🦠', maxHealth: 49, cap: 3,
      response: { name: 'Water treatment', cost: 6 },
      text: 'The unhealthy river has an algal bloom. Farms and the town can take at most 3 units this season unless the fund pays for water treatment.',
      simple: 'Green slime in the sick river! Farms and the town can take only 3 units unless the fund pays to clean it.',
      advanced: 'Poor river health is an externality that costs every user.',
      teaching: 'Poor river health costs everyone.',
    },
    buyback: {
      id: 'buyback', name: 'Water buy-back', icon: '📜', region: 'cotton', cap: 6, compensation: 10,
      text: 'The government buys back water for the environment: Cotton Flats can take at most 6 units this season and receives 10 points compensation.',
      simple: 'The government pays Cotton Flats 10 points to take less water (6 at most) this season.',
      advanced: 'Policy changes the allocation of water between users and the environment.',
      teaching: 'Policy changes who gets water.',
    },
    goodrains: {
      id: 'goodrains', name: 'Good rains', icon: '🌈', inflowMult: 1.3, health: 5,
      text: 'Good rains: 30% more water this season and the river recovers 5 health.',
      simple: 'Lovely rain! More water and a healthier river.',
      advanced: 'Variability works in both directions.',
      teaching: 'Variability works in both directions.',
    },
    grant: {
      id: 'grant', name: 'Government grant', icon: '🎁', minHealth: 60, amount: 12,
      text: 'A grant for healthy rivers: if river health is 60 or more at the end of this season, the Catchment Fund receives 12 points.',
      simple: 'If the river is healthy at the end of this season, the fund gets 12 free points.',
      advanced: 'Cooperation can attract outside investment.',
      teaching: 'Cooperation can attract investment.',
    },
  };

  const PROJECTS = {
    raisedam: { id: 'raisedam', name: 'Raise the dam', icon: '🏗️', cost: 14, for: ['highlands'], text: 'Dam capacity rises from 10 to 15.' },
    drip: { id: 'drip', name: 'Drip irrigation', icon: '🚿', cost: 12, for: ['orchard', 'cotton', 'springs'], factor: 1.33, text: 'Each unit you take counts as 1.33 units for your crops (rounded down).' },
    recycling: { id: 'recycling', name: 'Recycling plant', icon: '♻️', cost: 10, for: ['town'], text: 'Your essential need drops from 3 units to 2.' },
    wetland: { id: 'wetland', name: 'Wetland restoration', icon: '🌿', cost: 12, for: ['delta'], health: 3, text: '+3 river health every season, and sea flow scores 4 points a unit.' },
    levee: { id: 'levee', name: 'Levee', icon: '🧱', cost: 10, for: 'below-dam', text: 'You are immune to flood damage.' },
  };

  const YEAR_LEVELS = {
    'y4-6': { id: 'y4-6', label: 'Years 4 to 6', seasons: 6, planTimer: 210, pledges: false, hazards: [1, 1], fundStep: 2, pumping: false, wording: 'simple' },
    'y7-8': { id: 'y7-8', label: 'Years 7 to 8', seasons: 8, planTimer: 150, pledges: true, hazards: [2, 3], fundStep: 1, pumping: false, wording: 'standard' },
    'y9-12': { id: 'y9-12', label: 'Years 9 to 12', seasons: 9, planTimer: 120, pledges: true, hazards: [3, 4], fundStep: 1, pumping: true, wording: 'advanced' },
  };

  const LIMITS = {
    seasons: [6, 10],
    planTimer: [60, 300],
    teams: [4, 6],
    maxPendingPledges: 3,
    maxPledgePayment: 30,
    pumpExtra: 2,       // illegal pumping: up to 2 hidden extra units
    auditCost: 2,
    auditPenalty: 6,
  };

  const TIMING = { forecast: 45, release: 20, addSeconds: 30 };

  const QUESTIONS = {
    broken: { text: 'Who took more than they pledged, and what did it cost the river?', simple: 'Who broke a promise? How did that change the river?' },
    lowSea: { text: 'The river barely reached the sea. Which choices upstream caused that, and who paid the cost?', simple: 'Not much water reached the sea. Why? Who lost out?' },
    crisis: { text: 'The river is in crisis and everyone\'s points were halved. What would it take to bring it back?', simple: 'The river is very sick and everyone lost half their points. How can we fix it?' },
    hazard: { text: 'How did the hazard change things? Was the Catchment Fund ready for it?', simple: 'What did the hazard do? Did the fund help?' },
    healthy: { text: 'Enough water reached the sea this season. What did teams give up to make that happen?', simple: 'The river is doing well. Who shared water to make that happen?' },
    general: [
      { text: 'Which team depends most on the others? Why?', simple: 'Which team needs the others most?' },
      { text: 'Is it fair that upstream regions get first use of the water?', simple: 'Is it fair that teams at the top of the river get water first?' },
      { text: 'What would you do differently if you knew next season was dry?', simple: 'What would you do if next season is dry?' },
      { text: 'Who benefits when one team takes less? Who benefits when it takes more?', simple: 'Who wins when a team takes less water?' },
    ],
  };

  const DEBRIEF = [
    'Which region had the most power over the river, and why?',
    'When did your team take more than it needed? What did that cost the regions downstream?',
    'Were the pledges fair? Who kept them, who broke them, and what happened to trust?',
    'How did the Catchment Fund help when hazards struck? Would you contribute more next time?',
    'What would a sustainable plan for this river look like? What are the trade-offs between farms, the town, power and the environment?',
    'Real rivers such as the Murray–Darling Basin face these same problems. What do governments and communities do there?',
    'Water has cultural, spiritual and aesthetic value, including for First Nations Australians, that points cannot measure. What does this game leave out? (Teacher: use material developed or reviewed with First Nations educators or a local Elder.)',
    'In your class, did cooperation or competition win? Why?',
  ];

  // Pick the wording variant for the year level.
  function word(item, wording) {
    if (!item) return '';
    if (typeof item === 'string') return item;
    if (wording === 'simple' && item.simple) return item.simple;
    if (wording === 'advanced' && item.advanced) return item.text + ' ' + item.advanced;
    return item.text;
  }

  return {
    START, HEALTH, REGIONS, LAYOUTS, CLIMATES, HAZARDS, PROJECTS, YEAR_LEVELS, LIMITS, TIMING, QUESTIONS, DEBRIEF, word,
    CLIMATE_IDS: Object.keys(CLIMATES),
    HAZARD_IDS: Object.keys(HAZARDS),
    PROJECT_IDS: Object.keys(PROJECTS),
  };
});
