const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Function to find all .ipynb files in the given directory
function findIpynbFiles(dir) {
  let results = [];
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      results = results.concat(findIpynbFiles(filePath));
    } else if (path.extname(file) === '.ipynb') {
      results.push(filePath);
    }
  }
  return results;
}

// Main function to check links
function checkLinks() {
  const ignorePatterns = [
    'https://(api|web)\\.smith\\.langchain\\.com/.*',
    'https://x\\.com/.*'
  ];

  const ipynbFiles = findIpynbFiles('.');
  console.log('Found .ipynb files:', ipynbFiles);

  for (const file of ipynbFiles) {
    console.log(`Checking links in ${file}`);
    try {
      execSync(`yarn run linkinator ${file} ${ignorePatterns.map(pattern => `--skip "${pattern}"`).join(' ')}`, { stdio: 'inherit' });
    } catch (error) {
      if (error.status === 5) {
        console.log('Broken links found, but continuing...');
      } else {
        throw error;
      }
    }
  }
}

checkLinks();