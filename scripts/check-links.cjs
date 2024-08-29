const { execSync } = require('child_process');

const ignorePatterns = [
  'https://(api|web)\\.smith\\.langchain\\.com/.*',
  'https://x\\.com/.*'
];

function checkLinks() {
  const changedFiles = process.env.CHANGED_FILES ? process.env.CHANGED_FILES.split(' ') : [];
  const ipynbFiles = changedFiles.filter(file => file.endsWith('.ipynb'));

  console.log('Changed .ipynb files:', ipynbFiles);

  if (ipynbFiles.length === 0) {
    console.log('No .ipynb files were changed. Skipping link check.');
    return;
  }

  for (const file of ipynbFiles) {
    console.log(`Checking links in ${file}`);
    try {
      execSync(`yarn linkinator ${file} ${ignorePatterns.map(pattern => `--skip "${pattern}"`).join(' ')}`, { stdio: 'inherit' });
    } catch (error) {
      console.error(`Error checking links in ${file}:`, error);
      process.exit(1);
    }
  }
}

checkLinks();