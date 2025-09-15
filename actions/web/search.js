const https = require('https');

// Replace these with your own API key and search engine ID
const API_KEY = 'REPLACE_ME';
const SEARCH_ENGINE_ID = 'REPLACE_ME';

// Parse command-line arguments for the query
const args = process.argv.slice(2);
let query = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-q') {
    query = args[i + 1];
    break;
  }
}

if (!query) {
  console.error('Please provide a query with -q');
  process
    .exit(1);
}

// Construct the API request URL
const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}`;

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const results = JSON.parse(data).items;

      if (results && results.length > 0) {
        for (let i = 0; i < results.length; i++) {
          console.log(`[${i + 1}] ${results[i].title}`);
          console.log(`    ${results[i].link}\n`);
        }
      } else {
        console.log('No results found.');
      }
    } catch (e) {
      console.error('Error parsing response:', e.message);
    }
  });
}).on('error', (e) => {
  console.error(`Error: ${e.message}`);
});
