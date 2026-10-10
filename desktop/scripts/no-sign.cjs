// Stand-in for Windows code signing: `npm run dist:unsigned` builds without touching the signing token.
exports.default = async function noSign() {}
