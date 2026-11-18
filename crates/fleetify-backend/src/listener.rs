//! The backend's listening socket.
//!
//! [`bind_exclusive`] binds and listens the way `tokio::net::TcpListener::bind`
//! does, with one difference on Windows: it sets `SO_EXCLUSIVEADDRUSE` before
//! it binds, so that no other socket can bind the listener's address and port
//! while it holds them, whatever options that socket sets.
//!
//! Elsewhere it sets `SO_REUSEADDR`, as tokio does, so that a relaunch can
//! bind the port while the last run's connections are in `TIME_WAIT`. On
//! those systems a socket listening on an address and port already keeps
//! every other socket off them.
//!
//! Child processes don't inherit the socket: `TcpSocket` creates it
//! close-on-exec, and non-inheritable on Windows.

use std::io;
use std::net::SocketAddr;

use tokio::net::{TcpListener, TcpSocket};

/// The listen backlog `TcpListener::bind` passes on these platforms (through
/// mio's `TcpListener::bind`, which uses the standard library's value).
const BACKLOG: u32 = 128;

/// Bind `addr` and listen on it. While the listener is open, no other socket
/// can bind its address and port (see the module docs).
///
/// Like `TcpListener::bind`, it has to run inside a Tokio runtime: the
/// listener registers with the runtime's reactor.
pub fn bind_exclusive(addr: SocketAddr) -> io::Result<TcpListener> {
    let socket = if addr.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    #[cfg(windows)]
    set_exclusive_address_use(&socket)?;
    #[cfg(not(windows))]
    socket.set_reuseaddr(true)?;
    socket.bind(addr)?;
    socket.listen(BACKLOG)
}

/// Set `SO_EXCLUSIVEADDRUSE` on `socket`, which isn't bound yet: Windows
/// applies the option when the socket binds.
#[cfg(windows)]
fn set_exclusive_address_use(socket: &TcpSocket) -> io::Result<()> {
    use std::os::windows::io::AsRawSocket;

    use windows_sys::Win32::Networking::WinSock::{
        setsockopt, SOCKET, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
    };

    let enable: i32 = 1;
    // SAFETY: `socket` owns the handle and stays borrowed for the whole
    // call, so the handle is open. `optval` points at `enable`, a live i32,
    // and `optlen` is its size, so setsockopt reads only those four bytes,
    // and only during the call.
    let rc = unsafe {
        setsockopt(
            socket.as_raw_socket() as SOCKET,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            std::ptr::from_ref(&enable).cast::<u8>(),
            std::mem::size_of::<i32>() as i32,
        )
    };
    if rc != 0 {
        // SOCKET_ERROR. Winsock leaves the cause in the thread's last-error
        // value, which `last_os_error` reads (socket2 maps Winsock errors
        // the same way).
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, SocketAddr};

    use tokio::net::TcpSocket;

    use super::bind_exclusive;

    fn loopback(port: u16) -> SocketAddr {
        SocketAddr::from((Ipv4Addr::LOCALHOST, port))
    }

    #[tokio::test]
    async fn a_taken_port_cannot_be_bound_again() {
        let listener = bind_exclusive(loopback(0)).expect("bind the listener");
        let port = listener.local_addr().expect("local address").port();

        let other = TcpSocket::new_v4().expect("create a second socket");
        other.set_reuseaddr(true).expect("set SO_REUSEADDR");
        let bound = other.bind(loopback(port));

        assert!(
            bound.is_err(),
            "a second socket bound 127.0.0.1:{port} while the listener held it"
        );
        drop(listener);
    }

    /// Windows may refuse an exclusive bind to a port while a connection
    /// that an exclusive listener accepted there is still active. After a
    /// quit, the last run's connections whose server side closed first sit
    /// in `TIME_WAIT` on the port for a while. This test sets up such a
    /// connection, then binds again at once.
    #[cfg(windows)]
    #[tokio::test]
    async fn rebinding_right_after_close_succeeds() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let listener = bind_exclusive(loopback(0)).expect("bind the listener");
        let addr = listener.local_addr().expect("local address");
        let mut client = TcpStream::connect(addr).await.expect("connect");
        let (mut accepted, _) = listener.accept().await.expect("accept");

        // The server side closes first: it sends FIN, and the client reads
        // EOF.
        accepted.shutdown().await.expect("server shutdown");
        let mut byte = [0u8; 1];
        let read = client.read(&mut byte).await.expect("client read");
        assert_eq!(read, 0, "the client read data instead of EOF");
        // Then the client closes. Once the server side reads EOF it has the
        // client's FIN, so its end of the connection, on the listener's
        // port, is in TIME_WAIT. Waiting on the two reads, not on a timer,
        // is what makes that state certain.
        drop(client);
        let read = accepted.read(&mut byte).await.expect("server read");
        assert_eq!(read, 0, "the server side read data instead of EOF");
        drop(accepted);
        drop(listener);

        let rebound = bind_exclusive(addr);
        assert!(
            rebound.is_ok(),
            "binding {addr} again right after close failed: {rebound:?}"
        );
    }
}
