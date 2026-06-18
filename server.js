const express = require('express');
const app = express();
const port = 3000;
const axios = require('axios');
const geolocation = require('geolocation');

let userLocation = null;

app.use(express.json());

app.post('/message', (req, res) => {
  const message = req.body.message;
  if (message.toLowerCase().includes('location')) {
    geolocation.getCurrentPosition((err, position) => {
      if (err) {
        res.send('Unable to get location');
      } else {
        userLocation = position;
        res.send(`Your location is ${position.coords.latitude}, ${position.coords.longitude}`);
      }
    });
  } else if (message.toLowerCase().includes('weather')) {
    if (userLocation) {
      const lat = userLocation.coords.latitude;
      const lon = userLocation.coords.longitude;
      axios.get(`http://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=YOUR_OPENWEATHERMAP_API_KEY`)
        .then(response => {
          res.send(`The weather is ${response.data.weather[0].description} with a temperature of ${response.data.main.temp} Kelvin`);
        })
        .catch(error => {
          res.send('Unable to get weather');
        });
    } else {
      res.send('Please provide your location first');
    }
  } else {
    res.send('I did not understand that');
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});