'use strict';
const path=require('node:path');
const {databasePath,initializeDatabase}=require('../core/database-startup');
if(process.argv.length!==3 || process.argv[2]!=='--create-new-database'){
 console.error('Usage: node scripts/initialize-database.cjs --create-new-database (first installation only; never recovery)');process.exitCode=2;
}else{
 try{const file=databasePath(path.resolve(__dirname,'..'));initializeDatabase(file);console.log('Initialized new Chatbot schema at '+file);}
 catch(error){console.error(error.message);process.exitCode=1;}
}
