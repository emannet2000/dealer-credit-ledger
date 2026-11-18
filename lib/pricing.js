"use strict";
// Quantity bundle rules, for example "Buy 2, Take 1 at ₱162" (or take 1 free).
// A bundle lives on a product's promo object:
//   promo: { price: 210.75, from, to, noDiscount, bundle: { buy: 2, take: 1, takePrice: 162 } }
// `price` is what a "buy" unit costs; the `take` units are charged `takePrice`
// (0 = free). Every unit, including the take ones, still comes out of stock.
// Older saved promos may use `free` instead of `take`; they are treated as free.

function bundleOf(promo) {
  const b = promo && promo.bundle;
  if (!b) return null;
  const buy = Number(b.buy), take = Number(b.take != null ? b.take : b.free);
  const takePrice = b.takePrice == null || b.takePrice === "" ? 0 : Number(b.takePrice);
  if (!Number.isInteger(buy) || !Number.isInteger(take) || buy < 1 || take < 1 || buy > 1000 || take > 1000) return null;
  if (!Number.isFinite(takePrice) || takePrice < 0) return null;
  return { buy, take, takePrice };
}

function inWindow(promo, date) {
  return !!promo && (!promo.from || date >= promo.from) && (!promo.to || date <= promo.to);
}

function bundleActive(promo, date) {
  return !!bundleOf(promo) && inWindow(promo, date);
}

// Total units taken -> how many are charged the bundle price. The rule repeats
// only for each complete set: Buy 4 Take 1 gives 1 at 5 units, 2 at 10.
function takeUnits(qty, promo, date) {
  const b = bundleOf(promo);
  const total = Math.max(0, Math.floor(Number(qty) || 0));
  if (!b || !inWindow(promo, date)) return 0;
  return Math.min(total, Math.floor(total / (b.buy + b.take)) * b.take);
}

module.exports = { bundleOf, bundleActive, takeUnits };
