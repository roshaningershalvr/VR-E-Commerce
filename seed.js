const { initializeDatabase, db } = require('./server');

initializeDatabase()
  .then(() => {
    console.log('Database initialized and seeded.');
    db.close();
  })
  .catch(err => {
    console.error('Failed to seed database:', err);
    db.close();
    process.exit(1);
  });
