// BENIGN. Reads ordinary configuration from the environment, always, and never sends anything.
const mode = process.env.NODE_ENV || 'development';
const port = process.env.PORT || 3000;
module.exports = { mode, port };
