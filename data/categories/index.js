"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.allSlugs = exports.categoryBySlug = exports.allGroups = exports.socialMediaEntertainment = exports.prepaid = exports.directTopUp = exports.giftCards = exports.gameVouchers = void 0;
const game_vouchers_json_1 = __importDefault(require("./game-vouchers.json"));
exports.gameVouchers = game_vouchers_json_1.default;
const gift_cards_json_1 = __importDefault(require("./gift-cards.json"));
exports.giftCards = gift_cards_json_1.default;
const direct_top_up_json_1 = __importDefault(require("./direct-top-up.json"));
exports.directTopUp = direct_top_up_json_1.default;
const prepaid_json_1 = __importDefault(require("./prepaid.json"));
exports.prepaid = prepaid_json_1.default;
const social_media_entertainment_json_1 = __importDefault(require("./social-media-entertainment.json"));
exports.socialMediaEntertainment = social_media_entertainment_json_1.default;
/** All groups in display order */
exports.allGroups = [
    game_vouchers_json_1.default,
    gift_cards_json_1.default,
    direct_top_up_json_1.default,
    prepaid_json_1.default,
    social_media_entertainment_json_1.default,
];
/** Flat lookup: slug → { name, groupId, groupTitle } */
exports.categoryBySlug = Object.fromEntries(exports.allGroups.flatMap((group) => group.categories.map((cat) => [
    cat.slug,
    { ...cat, groupId: group.id, groupTitle: group.title },
])));
/** All category slugs for static generation */
exports.allSlugs = exports.allGroups.flatMap((g) => g.categories.map((c) => c.slug));
