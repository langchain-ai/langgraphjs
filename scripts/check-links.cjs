const fs = require('fs');
const path = require('path');
const { LinkChecker } = require('linkinator');

const ignorePatterns = [
  'https://(api|web)\\.smith\\.langchain\\.com/.*',
  'https://x\\.com/.*'
];

async function findIpynbFiles(dir) {
  const files = await fs.promises.readdir(dir);
  let results = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) {
      results = results.concat(await findIpynbFiles(filePath));
    } else if (path.extname(file) === '.ipynb') {
      results.push(filePath);
    }
  }
  return results;
}

async function checkLinks() {
  const ipynbFiles = await findIpynbFiles('.');
  console.log('Found .ipynb files:', ipynbFiles);

  const checker = new LinkChecker();

  checker.on('link', (result) => {
    console.log(`${result.status} ${result.url}`);
  });

  for (const file of ipynbFiles) {
    console.log(`Checking links in ${file}`);
    try {
      const result = await checker.check({
        path: file,
        recurse: false,
        linksToSkip: ignorePatterns,
      });
      
      if (result.passed) {
        console.log(`All links in ${file} are valid.`);
      } else {
        console.error(`Broken links found in ${file}.`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Error checking links in ${file}:`, error);
      process.exitCode = 1;
    }
  }
}

checkLinks().catch(error => {
  console.error('An error occurred:', error);
  process.exitCode = 1;
});