// Server is the only source of truth for what a pack/plan costs and grants --
// never trust a client-sent price or credit amount. Mirrors the numbers shown
// in the pricing modal in index.html.
const PACKS = {
  '500': { credits: 500, usd: 500 },
  '1000': { credits: 1000, usd: 1000 },
  '2000': { credits: 2000, usd: 2000 },
  '4000': { credits: 4000, usd: 5000 },
};

// monthlyCredits is granted on every paid invoice (first one + each renewal).
// Pro+ isn't listed with its own credit number in the pricing modal ("Everything
// in Business" + higher limits) -- treated as inheriting Business's 1,000/mo.
const PLANS = {
  pro: { name: 'Pro', usd: 1000, monthlyCredits: 500 },
  business: { name: 'Business', usd: 2000, monthlyCredits: 1000 },
  pro_plus: { name: 'Pro+', usd: 5000, monthlyCredits: 1000 },
};

module.exports = { PACKS, PLANS };
