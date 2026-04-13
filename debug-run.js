const fs = require('fs');
try {
  require('./server.js');
} catch(e) {
  fs.writeFileSync('err.txt', e.stack);
}
