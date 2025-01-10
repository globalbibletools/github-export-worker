export default {
  "**/*": "prettier --write --skip-unknown",
  "*.{ts,tsx}": () => ["npm run check-types", "npm run lint"],
};
