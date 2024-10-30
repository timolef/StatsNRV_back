const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const mysql = require('mysql2');
require('dotenv').config();
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

function authenticateToken(req, res, next) {
  const token = req.headers['authorization'];
  
  if (!token) {
    return res.status(401).json({ message: 'Accès refusé : Aucun token fourni' });
  }

  jwt.verify(token.split(' ')[1], JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Token invalide' });
    }
    req.user = user;
    next();
  });
}

db.connect(err => {
  if (err) {
    console.error('Erreur de connexion à la base de données:', err);
    return;
  }
  console.log('Connecté à la base de données MySQL');
});
const JWT_SECRET = process.env.JWT_SECRET
function calculatePlayerPerformance(playerStats) {
  function scorePlayer(games) {
    function convertToSeconds(toi) {
      const [minutes, seconds] = toi.split(':').map(Number);  // Diviser en minutes et secondes, puis convertir en nombres
      return minutes * 60 + seconds;  // Convertir en secondes
    }

    // Calcul des sommes des statistiques pour les 5 derniers matchs
    const totalShots = games.reduce((sum, g) => sum + g.shots, 0);
    const totalGoals = games.reduce((sum, g) => sum + g.goals, 0);
    const totalTOI = games.reduce((sum, g) => sum + convertToSeconds(g.toi || '0:00'), 0);  // Convertir TOI en secondes

    // Ajouter une pénalité si le joueur a joué mais n'a ni tiré ni marqué
    const playedWithoutShotOrGoal = games.reduce((count, g) => {
      return count + (g.shots === 0 && g.goals === 0 ? 1 : 0);  // Compter les matchs où le joueur n'a ni tiré ni marqué
    }, 0);

    // Si le joueur n'a pas joué ou n'a aucune donnée valable, renvoyer un score de 0
    if (totalTOI === 0) return 0;

    // Normalisation par le temps de jeu : ratio de buts par tirs
    const goalsPerShot = totalShots > 0 ? totalGoals / totalShots : 0;  // Buts par tir, éviter division par 0
    const toiFactor = totalTOI / (60 * games.length);  // Temps de jeu moyen par minute sur les 5 matchs

    // Pénalisation basée sur le nombre de matchs joués sans tir ou but
    const penalty = playedWithoutShotOrGoal / games.length;  // Ratio de matchs sans performance

    // Calcul du score basé sur le ratio de buts par tirs, ajusté par le temps de jeu moyen et la pénalité
    const score = (goalsPerShot * toiFactor) - penalty;  // Le score est pénalisé si le joueur n'a pas tiré ou marqué

    return score > 0 ? score/10 : 0;  // Empêcher les scores négatifs
  }

  // Calculer le score de chaque joueur sur la base des 5 derniers matchs
  playerStats.forEach(player => {
    const recentGames = player.gameLog.slice(0,5);  // Prendre les 5 derniers matchs
    player.score = scorePlayer(recentGames);
  });

  // Retourner les 50 meilleurs joueurs triés par score
  return playerStats
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}





// Middleware
app.use(cors());
app.use(express.json());


app.get('/api/user-info', authenticateToken, (req, res) => {
  const userId = req.user.id;

try {
    // Requête à la base de données pour récupérer les infos de l'utilisateur
  db.query('SELECT email, is_premium, created_date FROM users WHERE id = ?', [userId], (err, result) => {
    if (err) {
      return res.status(500).json({ message: 'Erreur lors de la récupération des informations utilisateur' });
    }

    if (result.length === 0) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }

    const userInfo = result[0];
    res.json({userInfo});
  });
} catch (error) {
    console.log(error)
}

  
});

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

app.get('/match/:id', async (req, res) => {
  const matchId = req.params.id;
  
  try {
    // Utilise l'API pour récupérer les détails du match
    const response = await axios.get(`https://api-web.nhle.com/v1/gamecenter/${matchId}/landing`);
    const matchDetails = response.data;
    
    // Renvoie les données du match
    res.status(200).json(matchDetails);
  } catch (error) {
    console.error(`Erreur lors de la récupération des détails du match avec id ${matchId}:`, error.message);
    res.status(500).json({ error: 'Erreur lors de la récupération des détails du match' });
  }
});

app.get('/rosters/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  
  try {
    // Utilise l'API pour récupérer les détails du match
    const response = await axios.get(`https://api-web.nhle.com/v1/gamecenter/${matchId}/play-by-play`);
    const matchDetails = response.data.rosterSpots;
    
    // Renvoie les données du match
    res.status(200).json(matchDetails);
  } catch (error) {
    console.error(`Erreur lors de la récupération des détails du match avec id ${matchId}:`, error.message);
    res.status(500).json({ error: 'Erreur lors de la récupération des détails du match' });
  }
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
        shotsForPG: team.shotsForPerGame,
        shotsAgainstPG: team.shotsAgainstPerGame,
        goalsAgainstPG: team.goalsAgainstPerGame,
        wins: team.wins,
        regulationWins: team.winsInRegulation,
        shootoutWins: team.winsInShootout,
        losses: team.losses,
        otLosses: team.otLosses,
        points: team.points,
      }));
      res.json(teamStats);
    } catch (error) {
      console.error('Error fetching team stats:', error);
      res.status(500).json({ message: 'Error fetching team stats' });
    }
  });

  app.post('/api/register', async (req, res) => {
    try {
      const { email, password, pseudo } = req.body;
  
    // Vérifier si l'utilisateur existe déjà
    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, result) => {
      if (result.length > 0) {
        return res.status(400).json({ message: 'Utilisateur déjà existant' });
      }
  
      // Hash du mot de passe
      const hashedPassword = await bcrypt.hash(password, 10);
  
      // Insérer l'utilisateur dans la base de données
      db.query('INSERT INTO users (email, password, pseudo) VALUES (?, ?, ?)', [email, hashedPassword, pseudo], (err, result) => {
        if (err) {
          return res.status(500).json({ message: 'Erreur lors de l\'inscription' });
        }
        res.json({ message: 'User created' });
      });
    });
    } catch (error) {
      console.error(error)
    }
    
  });
  
  // Route de connexion
  app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
  
    // Vérifier si l'utilisateur existe
    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, result) => {
      if (err || result.length === 0) {
        return res.status(400).json({ message: 'Email ou mot de passe incorrect' });
      }
  
      const user = result[0];
  
      // Vérifier le mot de passe
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(400).json({ message: 'Email ou mot de passe incorrect' });
      }
  
      // Créer un token JWT
      const token = jwt.sign({ id: user.id, email: user.email,pseudo: user.pseudo, is_premium: user.is_premium }, JWT_SECRET, { expiresIn: '1h' });
      res.json({ token });
    });
  });

  app.get('/score-matches', async (req, res) => {
    try {
      const date = req.query.date; // Récupérer la date depuis les paramètres de la requête
      const nhlApiUrl = `https://api-web.nhle.com/v1/score/${date}`; // Utiliser la date dans l'URL
      const response = await axios.get(nhlApiUrl);
      console.log(response.data.games);
  
      const convertToUTC2 = (utcTime) => {
        const date = new Date(utcTime); // Crée un objet Date à partir de l'heure UTC
        return date.toLocaleTimeString('fr-FR', {
          timeZone: 'Europe/Paris', // Fuseau horaire UTC+2 (Paris)
          hour: '2-digit',
          minute: '2-digit',
        });
      };
  
      // Transformation des données pour le front-end
      const matches = response.data.games.map(game => ({
        gameDate: game.gameDate,
        gameId: game.id,
        gameTime: convertToUTC2(game.startTimeUTC),
        gameState: game.gameState,
        teams: {
          homeTeam: {
            score: game.homeTeam.score,
            name: game.homeTeam.name.default,
            abbrev: game.homeTeam.abbrev,
            logo: game.homeTeam.logo
          },
          awayTeam: {
            score: game.awayTeam.score,
            name: game.awayTeam.name.default,
            abbrev: game.awayTeam.abbrev,
            logo: game.awayTeam.logo
          }
        }
      }));
  
      res.json(matches);
    } catch (error) {
      console.error('Error fetching live matches:', error);
      res.status(500).send('Error fetching live matches');
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