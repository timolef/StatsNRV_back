const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

function calculatePlayerPerformance(playerStats) {
  const playersWithShots = playerStats.filter(p => p.gameLog.some(g => g.shots > 0)); // Ne garder que les joueurs avec des tirs dans leurs 5 derniers matchs

  function scorePlayer(games) {
    function convertToSeconds(toi) {
      const [minutes, seconds] = toi.split(':').map(Number);  // Diviser en minutes et secondes, puis convertir en nombres
      return minutes * 60 + seconds;  // Convertir en secondes
  }

  // Calcul des sommes des statistiques pour les 5 derniers matchs
  const totalShots = games.reduce((sum, g) => sum + g.shots, 0);
  const totalGoals = games.reduce((sum, g) => sum + g.goals, 0);
  const ppGoals = games.reduce((sum, g) => sum + (g.ppGoals || 0), 0);
  const totalTOI = games.reduce((sum, g) => sum + convertToSeconds(g.toi || '0:00'), 0);  // Convertir TOI en secondes

  // Si aucun tir n'a été tenté ou si le temps de jeu est zéro, renvoyer un score de 0
  if (totalShots === 0 || totalTOI === 0) return 0;

  // Normalisation par le temps de jeu
  const shotsPerMinute = totalShots / (totalTOI / 60);   // Tirs par minute
  const goalsPerMinute = totalGoals / (totalTOI / 60);   // Buts par minute
  const ppGoalsPerMinute = ppGoals / (totalTOI / 60);    // Buts en Power Play par minute

  // Influence de chaque statistique sur le score total
  const goalShotRatio = goalsPerMinute / shotsPerMinute;  // Ratio buts/tirs par minute
  const ppInfluence = ppGoalsPerMinute * 0.8;            // Influence du Power Play ajustée par minute
  const toiInfluence = totalTOI / (1500 * games.length);  // Influence du temps de jeu moyen
  const recentGoals = goalsPerMinute;                    // Buts récents par minute
  const shootingOpportunities = shotsPerMinute / 100;    // Opportunités de tir par minute

  // Calcul du score ajusté
  const score = goalShotRatio * 0.5 +
                ppInfluence * 0.3 +
                toiInfluence * 0.2 +
                recentGoals * 0.2 +
                shootingOpportunities * 0.3;
  
  console.log("score = ", score);
  return score;
  }

  playersWithShots.forEach(player => {
    const recentGames = player.gameLog;  // On utilise maintenant uniquement les 5 derniers matchs déjà récupérés
    player.score = scorePlayer(recentGames);
  });

  return playersWithShots
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
}

// MySQL connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

db.connect((err) => {
  if (err) throw err;
  console.log('MySQL Connected...');
});

// Middleware
app.use(cors());
app.use(express.json());

app.get('/top-players', async (req, res) => {
  try {
    const { seasonId } = req.query;
    const nhlApiUrl = `https://api.nhle.com/stats/rest/en/skater/summary?sort=[{"property":"goals","direction":"DESC"}]&start=0&limit=150&cayenneExp=seasonId=${seasonId} and gameTypeId=2`;
    
    const response = await axios.get(nhlApiUrl);
    const playerStats = response.data.data;

    // Ajout : Récupération des 5 derniers matchs pour chaque joueur
    const playersWithGameLogs = await Promise.all(playerStats.map(async (player) => {
      const gameLogUrl = `https://api-web.nhle.com/v1/player/${player.playerId}/game-log/${seasonId}/2`;
      const gameLogResponse = await axios.get(gameLogUrl);
      const gameLog = gameLogResponse.data.gameLog;
      console.log(gameLog)
      return {
        ...player,
        gameLog: gameLog.slice(-5), // Prendre uniquement les 5 derniers matchs
      };
    }));

    const topPlayers = calculatePlayerPerformance(playersWithGameLogs);
    
    res.json(topPlayers);
  } catch (error) {
    console.error('Error fetching player stats:', error);
    res.status(500).send('Error fetching player stats');
  }
});

// User registration
app.post('/register', async (req, res) => {
  const { username, password, email, is_premium } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  const sql = 'INSERT INTO users (username, password, email, is_premium, created_date) VALUES (?, ?, ?, ?, NOW())';
  db.query(sql, [username, hashedPassword, email, is_premium], (err, result) => {
    if (err) return res.status(500).json(err);
    res.status(201).json({ message: 'User registered!' });
  });
});

app.get('/matches-week', async (req, res) => {
    const todayDate = new Date().toISOString().slice(0, 10); // Format YYYY-MM-DD pour aujourd'hui
    try {
      // Appel à l'API NHL pour récupérer les matchs de la semaine
      const nhlResponse = await axios.get(`https://api-web.nhle.com/v1/schedule/${todayDate}`);
      const matches = nhlResponse.data.gameWeek;
      res.json(matches);
    } catch (error) {
      console.error('Erreur lors de la récupération des matchs de la semaine:', error);
      res.status(500).json({ error: 'Erreur lors de la récupération des matchs.' });
    }
  });
  app.get('/api/player/:playerId', async (req, res) => {
    const { playerId } = req.params;
  
    try {
      const response = await axios.get(`https://api-web.nhle.com/v1/player/${playerId}/landing`);
      res.json(response.data); // Renvoie les données à votre front-end
    } catch (error) {
      console.error('Error fetching player stats:', error);
      res.status(500).json({ error: 'Failed to fetch player identity' });
    }
  });

  app.get('/api/milestones/skaters', async (req, res) => {
    try {
      const response = await axios.get(`https://api.nhle.com/stats/rest/en/milestones/skaters`);
      res.json(response.data);
    } catch (error) {
      console.error('Erreur lors de la récupération des milestones des patineurs :', error);
      res.status(500).json({ error: 'Erreur lors de la récupération des milestones des patineurs.' });
    }
  });
  
  app.get('/api/milestones/goalies', async (req, res) => {
    try {
      const response = await axios.get(`https://api.nhle.com/stats/rest/en/milestones/goalies`);
      res.json(response.data);
    } catch (error) {
      console.error('Erreur lors de la récupération des milestones des gardiens :', error);
      res.status(500).json({ error: 'Erreur lors de la récupération des milestones des gardiens.' });
    }
  });

  app.get('/api/team-stats/:season', async (req, res) => {
    const season = req.params.season;
  
    const nhlApiUrl = `https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=%5B%7B"property":"points","direction":"DESC"%7D,%7B"property":"wins","direction":"DESC"%7D,%7B"property":"teamId","direction":"ASC"%7D%5D&start=0&limit=50&cayenneExp=gameTypeId=2%20and%20seasonId%3C%3D${season}%20and%20seasonId%3E%3D${season}`;
  
    try {
      const response = await axios.get(nhlApiUrl);
      const teamStats = response.data.data.map(team => ({
        teamName: team.teamFullName,
        goalsFor: team.goalsFor,
        goalsForPG: team.goalsForPerGame,
        goalsAgainst: team.goalsAgainst,
        goalsAgainstPG: team.goalsAgainstPerGame,
        wins: team.wins,
        losses: team.losses,
        points: team.points,
      }));
      res.json(teamStats);
    } catch (error) {
      console.error('Error fetching team stats:', error);
      res.status(500).json({ message: 'Error fetching team stats' });
    }
  });

  app.get('/api/player/:playerId/stats/:selectedSeason', async (req, res) => {
    const { playerId, selectedSeason } = req.params;
  
    try {
      const response = await axios.get(`https://api-web.nhle.com/v1/player/${playerId}/game-log/${selectedSeason}/2`);
      res.json(response.data); // Renvoie les données à votre front-end
    } catch (error) {
      console.error('Error fetching player stats:', error);
      res.status(500).json({ error: 'Failed to fetch player stats' });
    }
  });

// User login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const sql = 'SELECT * FROM users WHERE username = ?';

  db.query(sql, [username], async (err, results) => {
    if (err) return res.status(500).json(err);
    if (results.length === 0) return res.status(401).json({ message: 'User not found' });

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.status(200).json({ token });
  });
});

// CORS proxy for external API
app.use('/api', createProxyMiddleware({
  target: 'https://api-web.nhle.com',
  changeOrigin: true,
  pathRewrite: {
    '^/api': '', // Remove '/api' prefix when forwarding the request
  },
}));

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));