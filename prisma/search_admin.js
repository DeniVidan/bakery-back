const fs = require('fs');
const readline = require('readline');

async function search() {
  const fileStream = fs.createReadStream('c:\\Users\\deniv\\Desktop\\Bakery-app\\frontend\\src\\components\\AdminDashboard.jsx');
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (line.toLowerCase().includes('starter') || line.toLowerCase().includes('feeding')) {
      if (line.toLowerCase().includes('assistant') || line.toLowerCase().includes('ratio') || line.toLowerCase().includes('method') || line.toLowerCase().includes('profile')) {
        console.log(`${lineNumber}: ${line.trim()}`);
      }
    }
  }
}

search();
