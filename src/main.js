import './style.css'
import castleUrl from './castle.svg'

const castle = document.querySelector('#castle')
const scoreElement = document.querySelector('[data-score]')
const addPointButton = document.querySelector('[data-action="add-point"]')

castle.src = castleUrl

let score = 0

function renderScore() {
  scoreElement.textContent = String(score)
}

addPointButton.addEventListener('click', () => {
  score += 1
  renderScore()
  addPointButton.classList.remove('pop')
  void addPointButton.offsetWidth
  addPointButton.classList.add('pop')
})

renderScore()
