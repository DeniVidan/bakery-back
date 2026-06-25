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
    if (line.includes('setCalculations')) {
      console.log(`${lineNumber}: ${line.trim()}`);
    }
  }
}

search();
