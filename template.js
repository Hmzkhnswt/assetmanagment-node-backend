const fs = require('fs');
const path = require('path');

// If you are already in the 
const folders = [
    'config',
    'routes',
    'controllers'
];

const files = [
    'config/db.js',
    'routes/accounts.js',
    'routes/transactions.js',
    'routes/reports.js',
    'controllers/accountController.js',
    'controllers/transactionController.js',
    'controllers/reportController.js',
    'server.js',
    '.env'
];

// 1. Create Folders
folders.forEach(folder => {
    fs.mkdirSync(folder, { recursive: true });
    console.log(`Created directory: ${folder}`);
});

// 2. Create Files
files.forEach(file => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `// ${path.basename(file)}`);
        console.log(`Created file: ${file}`);
    } else {
        console.log(`Skipping: ${file} already exists`);
    }
});

console.log('\nStructure created successfully within the current directory.');
