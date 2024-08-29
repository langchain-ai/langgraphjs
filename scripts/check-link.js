const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const markdownLinkCheck = require('markdown-link-check');

const ignoredUrls = [
  'https://(api|web)\\.smith\\.langchain\\.com/.*',
  'https://x\\.com/.*'
];

function convertNotebookToMarkdown(filePath) {
  return new Promise((resolve, reject) => {
    const outputPath = filePath.replace('.ipynb', '.md');
    exec(`jupyter nbconvert --to markdown "${filePath}" --output "${outputPath}"`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(outputPath);
      }
    });
  });
}

function checkLinks(filePath) {
  return new Promise((resolve, reject) => {
    const markdown = fs.readFileSync(filePath, 'utf8');
    markdownLinkCheck(markdown, {
      ignorePatterns: ignoredUrls,
      baseUrl: 'https://github.com', // Adjust this if needed
      httpHeaders: [
        {
          urls: ['https://github.com'],
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.63 Safari/537.36'
          }
        }
      ]
    }, (err, results) => {
      if (err) {
        reject(err);
      } else {
        const brokenLinks = results.filter(result => result.status === 'dead');
        resolve(brokenLinks);
      }
    });
  });
}

async function main() {
  const changedFiles = process.env.CHANGED_FILES.split(' ');
  const notebookFiles = changedFiles.filter(file => path.extname(file) === '.ipynb');

  for (const file of notebookFiles) {
    try {
      const markdownFile = await convertNotebookToMarkdown(file);
      const brokenLinks = await checkLinks(markdownFile);

      if (brokenLinks.length > 0) {
        console.error(`Broken links found in ${file}:`);
        brokenLinks.forEach(link => console.error(`- ${link.link}: ${link.statusCode}`));
        process.exit(1);
      } else {
        console.log(`No broken links found in ${file}`);
      }

      // Clean up the temporary markdown file
      fs.unlinkSync(markdownFile);
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
      process.exit(1);
    }
  }
}

main();