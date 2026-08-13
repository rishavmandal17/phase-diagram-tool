import React from 'react'
import ReactDOM from 'react-dom/client'
import Home from './Home.jsx' // Import your new clean file instead of App.jsx
import './index.css'

// This file targets the 'root' div in your HTML and swaps the code into it
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Home />
  </React.StrictMode>,
)
