import React from "react";
import { Link, useNavigate } from "react-router-dom"; // Adicionamos useNavigate
import Dropdown from 'react-bootstrap/Dropdown';
import userAvatar from "../assets/img/img1.jpg";

export default function Header() {
  const navigate = useNavigate();

  // 1. Função de Logout Real
  const handleLogout = (e) => {
    e.preventDefault();
    localStorage.removeItem("token"); // Remove a chave
    localStorage.removeItem("user");  // Remove os dados do Admin
    navigate("/pages/signin");        // Manda pro login
  };

  const CustomToggle = React.forwardRef(({ children, onClick }, ref) => (
    <Link
      to=""
      ref={ref}
      onClick={(e) => {
        e.preventDefault();
        onClick(e);
      }}
      className="dropdown-link"
    >
      {children}
    </Link>
  ));

  const toggleSidebar = (e) => {
    e.preventDefault();
    let isOffset = document.body.classList.contains("sidebar-offset");
    if (isOffset) {
      document.body.classList.toggle("sidebar-show");
    } else {
      if (window.matchMedia("(max-width: 991px)").matches) {
        document.body.classList.toggle("sidebar-show");
      } else {
        document.body.classList.toggle("sidebar-hide");
      }
    }
  }

  // Pegamos o nome do usuário do LocalStorage (se existir)
  const userData = JSON.parse(localStorage.getItem("user"));
  const userName = userData ? userData.username : "Admin";

  return (
    <div className="header-main px-3 px-lg-4">
      {/* Mantivemos o botão do menu para você não perder o controle da lateral */}
      <Link onClick={toggleSidebar} className="menu-link me-3 me-lg-4">
        <i className="ri-menu-2-fill"></i>
      </Link>

      <div className="me-auto"></div> {/* Espaçador para empurrar o perfil para a direita */}

      <Dropdown className="dropdown-profile ms-3 ms-xl-4" align="end">
        <Dropdown.Toggle as={CustomToggle}>
          <div className="avatar online">
            <img src={userAvatar} alt="" />
          </div>
        </Dropdown.Toggle>
        <Dropdown.Menu className="mt-10-f">
          <div className="dropdown-menu-body">
            <div className="avatar avatar-xl online mb-3">
              <img src={userAvatar} alt="" />
            </div>
            <h5 className="mb-1 text-dark fw-semibold">{userName}</h5>
            <p className="fs-sm text-secondary">Administrador</p>
            
            <hr />
            
            <nav className="nav">
              {/* Botão de Logout com a nossa função */}
              <Link onClick={handleLogout} className="nav-link text-danger">
                <i className="ri-logout-box-r-line"></i> Log Out
              </Link>
            </nav>
          </div>
        </Dropdown.Menu>
      </Dropdown>
    </div>
  )
}